// Minimal Discord REST client over fetch (Workers-native). Each call names its discord-api-types
// request and result types. Follows Discord's documented rate limits
// (https://discord.com/developers/docs/topics/rate-limits): per-route limits are tracked by
// their X-RateLimit-Bucket (plus the route's top-level resource), a bucket whose
// X-RateLimit-Remaining reached 0 is waited out, and a 429 is retried after `retry_after`,
// pausing every route when it is the global limit. Waits are capped so an invocation never
// sleeps for long; a longer limit fails the job, which then waits as long as Discord asks.

import type { Fetch } from "../chatwoot/api.ts";
import { isRecord, parseJson } from "../json.ts";

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (chatwoot-discord, 1)";
const MAX_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 3;

/**
 * A non-2xx answer from Discord. `code` is Discord's JSON error code when present; a rate limit
 * (429) carries how long to wait before trying again.
 */
export class DiscordHttpError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: number | undefined, discordMessage: string, retryAfterMs?: number) {
    super(`Discord HTTP ${status}${code === undefined ? "" : ` (code ${code})`}: ${discordMessage}`);
    this.name = "DiscordHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A request Discord refused as invalid, which fails the same way however often it is sent: a 4xx
 * other than 401 (token), 403 (permissions), 404 (a missing resource, which the relay recreates
 * or forgets), 408 (timeout), and 429 (rate limit), per
 * https://discord.com/developers/docs/topics/opcodes-and-status-codes#http. Anything else may
 * succeed later.
 */
export function isInvalidRequest(error: unknown): boolean {
  return (
    error instanceof DiscordHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 404, 408, 429].includes(error.status)
  );
}

interface DiscordRequest<Body = never, Query extends object = never> {
  body?: Body;
  query?: Query;
  /** Webhook and interaction-token routes authenticate by URL; send no bot token. */
  auth?: boolean;
  /** false: a rate limit fails the request at once, for one someone is waiting on. */
  retry?: boolean;
}

export class DiscordRest {
  /** Route -> the rate limit bucket Discord reported for it. */
  private readonly buckets = new Map<string, string>();
  /** Bucket key -> when it has requests again (ms since the epoch). */
  private readonly resets = new Map<string, number>();
  private globalReset = 0;
  private readonly token: string;
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  // Plain fields, not parameter properties: scripts/ runs this file with Node's type stripping.
  constructor(
    token: string,
    fetch: Fetch,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.token = token;
    this.fetch = fetch;
    this.sleep = sleep;
  }

  get<Result, Query extends object = never>(path: string, request?: DiscordRequest<never, Query>): Promise<Result> {
    return this.request("GET", path, request);
  }

  post<Result, Body, Query extends object = never>(
    path: string,
    request: DiscordRequest<Body, Query>,
  ): Promise<Result> {
    return this.request("POST", path, request);
  }

  patch<Result, Body>(path: string, request: DiscordRequest<Body>): Promise<Result> {
    return this.request("PATCH", path, request);
  }

  put<Result, Body>(path: string, request: DiscordRequest<Body>): Promise<Result> {
    return this.request("PUT", path, request);
  }

  delete<Result, Query extends object = never>(path: string, request?: DiscordRequest<never, Query>): Promise<Result> {
    return this.request("DELETE", path, request);
  }

  private async request<Result, Body, Query extends object>(
    method: string,
    path: string,
    request: DiscordRequest<Body, Query> = {},
  ): Promise<Result> {
    const route = `${method} ${path.replace(/\/messages\/[^/]+/, "/messages/:id")}`;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const url = `${API_BASE}${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const headers = new Headers({ "user-agent": USER_AGENT });
    if (request.auth !== false) headers.set("authorization", `Bot ${this.token}`);
    if (request.body !== undefined) headers.set("content-type", "application/json");

    for (let attempt = 1; ; attempt += 1) {
      const wait = Math.max(this.globalReset, this.resets.get(this.bucketKey(route, path)) ?? 0) - Date.now();
      if (wait > MAX_WAIT_MS || (wait > 0 && request.retry === false)) {
        throw new DiscordHttpError(429, undefined, "rate limited", wait);
      }
      if (wait > 0) await this.sleep(wait);

      const response = await this.fetch(
        new Request(url, {
          method,
          headers,
          // Never followed: a redirect could carry the bot token elsewhere, and each hop would be
          // a subrequest the budget does not count.
          redirect: "manual",
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }),
      );
      const text = await response.text();
      const bucket = response.headers.get("x-ratelimit-bucket");
      if (bucket) this.buckets.set(route, bucket);
      const key = this.bucketKey(route, path);
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        this.resets.set(key, Date.now() + seconds(response.headers.get("x-ratelimit-reset-after")) * 1000);
      }

      if (response.ok) return result(text);

      const data = parseJson(text);
      if (response.status === 429) {
        const retryAt = Date.now() + seconds(field(data, "retry_after") ?? response.headers.get("retry-after")) * 1000;
        if (field(data, "global") === true || response.headers.get("x-ratelimit-global") === "true") {
          this.globalReset = retryAt;
        } else {
          this.resets.set(key, retryAt);
        }
        const wait = Math.max(0, retryAt - Date.now());
        if (request.retry !== false && attempt < MAX_ATTEMPTS && wait <= MAX_WAIT_MS) continue;
        throw new DiscordHttpError(429, errorCode(data), errorMessage(data, response.statusText), wait);
      }
      throw new DiscordHttpError(response.status, errorCode(data), errorMessage(data, response.statusText));
    }
  }

  /** A bucket is shared per top-level resource (channel, guild, or webhook) in the path. */
  private bucketKey(route: string, path: string): string {
    const bucket = this.buckets.get(route);
    if (!bucket) return route;
    const major = /^\/(?:channels|guilds)\/\d+|^\/webhooks\/\d+\/[^/]+/.exec(path)?.[0] ?? "";
    return `${bucket}:${major}`;
  }
}

/**
 * A successful response's JSON (undefined for an empty body), typed by the caller's
 * discord-api-types result type. Discord's responses are trusted, not validated at runtime.
 */
function result(text: string) {
  return text === "" ? undefined : JSON.parse(text);
}

function field(data: unknown, key: string): unknown {
  return isRecord(data) ? data[key] : undefined;
}

function seconds(value: unknown): number {
  const number = Number(value ?? 1);
  return Number.isFinite(number) ? number : 1;
}

function errorCode(data: unknown): number | undefined {
  const code = field(data, "code");
  return typeof code === "number" ? code : undefined;
}

function errorMessage(data: unknown, fallback: string): string {
  const message = field(data, "message");
  return typeof message === "string" ? message.slice(0, 200) : fallback;
}
