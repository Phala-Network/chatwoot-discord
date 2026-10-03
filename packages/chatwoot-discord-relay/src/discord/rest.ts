import type { Fetch } from "../../../../shared/chatwoot/api.ts";
import { JobDeadlineError } from "../../../../shared/deadline.ts";
import { isRecord, parseJson } from "../../../../shared/json.ts";
import type { RateLimitStore } from "../../../../shared/rate-limit.ts";
import manifest from "../../package.json" with { type: "json" };
import { DiscordLimiter } from "./limiter.ts";

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = `DiscordBot (https://github.com/Phala-Network/chatwoot-workers, ${manifest.version})`;

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
  /** Prepare time-sensitive notification content only after the dispatch permits arrive. */
  prepareBody?: () => Body;
  query?: Query;
  /** Webhook and interaction-token routes authenticate by URL; send no bot token. */
  auth?: boolean;
  interaction?: boolean;
  signal?: AbortSignal;
}

export class DiscordRest {
  private readonly token: string;
  private readonly fetch: Fetch;
  private readonly limiter: DiscordLimiter;

  constructor(token: string, fetch: Fetch, limits?: RateLimitStore | DiscordLimiter) {
    this.token = token;
    this.fetch = fetch;
    const memory = new Map<string, string>();
    this.limiter =
      limits instanceof DiscordLimiter
        ? limits
        : new DiscordLimiter(
            limits ?? {
              get: (key) => memory.get(key),
              set: (key, value) => {
                memory.set(key, value);
              },
            },
          );
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

  patch<Result, Body, Query extends object = never>(
    path: string,
    request: DiscordRequest<Body, Query>,
  ): Promise<Result> {
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
    const permit = await this.limiter
      .reserve(method, path, this.token, request.auth !== false, request.interaction === true)
      .catch(() => {
        throw new JobDeadlineError();
      });
    if (!permit.allowed) throw new DiscordHttpError(429, undefined, "rate limited", permit.retryAfterMs);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const url = `${API_BASE}${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const headers = new Headers({ "user-agent": USER_AGENT });
    if (request.auth !== false) headers.set("authorization", `Bot ${this.token}`);
    if (request.body !== undefined) headers.set("content-type", "application/json");
    const body = request.prepareBody ? request.prepareBody() : request.body;

    const response = await this.fetch(
      new Request(url, {
        method,
        headers,
        redirect: "manual",
        ...(request.signal ? { signal: request.signal } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    const data = parseJson(text);
    const global = field(data, "global") === true || response.headers.get("x-ratelimit-global") === "true";
    const retryAfterMs =
      response.status === 429 ? seconds(field(data, "retry_after") ?? response.headers.get("retry-after")) * 1000 : 0;
    await this.limiter.report(
      {
        owner: permit.owner,
        reservation: permit.reservation,
        ...(response.headers.get("x-ratelimit-bucket")
          ? { bucket: response.headers.get("x-ratelimit-bucket") ?? "" }
          : {}),
        ...(response.headers.has("x-ratelimit-scope")
          ? { scope: response.headers.get("x-ratelimit-scope") ?? "" }
          : {}),
        ...(response.headers.has("x-ratelimit-remaining")
          ? { remaining: Number(response.headers.get("x-ratelimit-remaining")) }
          : {}),
        ...(response.headers.has("x-ratelimit-limit")
          ? { capacity: Number(response.headers.get("x-ratelimit-limit")) }
          : {}),
        resetAfterMs: response.headers.has("x-ratelimit-reset-after")
          ? seconds(response.headers.get("x-ratelimit-reset-after")) * 1000
          : 0,
        retryAfterMs,
        global: global && !request.interaction,
      },
      permit.globalOwner,
    );
    if (response.ok) return result(text);
    if (response.status === 429)
      throw new DiscordHttpError(429, errorCode(data), errorMessage(data, response.statusText), retryAfterMs);
    throw new DiscordHttpError(response.status, errorCode(data), errorMessage(data, response.statusText));
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
