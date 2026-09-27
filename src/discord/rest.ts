// Minimal Discord REST client over fetch (Workers-native). Follows Discord's documented rate
// limits (https://discord.com/developers/docs/topics/rate-limits): on 429 it waits `retry_after`
// and retries, and it waits out a bucket whose X-RateLimit-Remaining reached 0 before reusing
// the same route. Waits are capped so an invocation never sleeps for long; longer limits fail
// the job, which then retries with backoff.

import type { Fetch } from "../chatwoot/api.js";

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (chatwoot-discord, 1)";
const MAX_WAIT_MS = 10_000;
const MAX_ATTEMPTS = 3;

/** A non-2xx answer from Discord. `code` is Discord's JSON error code when present. */
export class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    discordMessage: string,
  ) {
    super(`Discord HTTP ${status}${code === undefined ? "" : ` (code ${code})`}: ${discordMessage}`);
    this.name = "DiscordHttpError";
  }
}

export interface DiscordRequest {
  body?: unknown;
  query?: URLSearchParams;
  /** Webhook and interaction-token routes authenticate by URL; send no bot token. */
  auth?: boolean;
}

export class DiscordRest {
  private readonly blockedUntil = new Map<string, number>();

  constructor(
    private readonly token: string | undefined,
    private readonly fetch: Fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  get(path: string, request: DiscordRequest = {}): Promise<unknown> {
    return this.request("GET", path, request);
  }

  post(path: string, request: DiscordRequest = {}): Promise<unknown> {
    return this.request("POST", path, request);
  }

  patch(path: string, request: DiscordRequest = {}): Promise<unknown> {
    return this.request("PATCH", path, request);
  }

  put(path: string, request: DiscordRequest = {}): Promise<unknown> {
    return this.request("PUT", path, request);
  }

  private async request(method: string, path: string, request: DiscordRequest): Promise<unknown> {
    const route = `${method} ${path}`;
    const url = `${API_BASE}${path}${request.query ? `?${request.query.toString()}` : ""}`;
    const headers = new Headers({ "user-agent": USER_AGENT });
    if (request.auth !== false) {
      if (!this.token) throw new Error("A Discord bot token is required for this request");
      headers.set("authorization", `Bot ${this.token}`);
    }
    if (request.body !== undefined) headers.set("content-type", "application/json");

    for (let attempt = 1; ; attempt += 1) {
      const wait = (this.blockedUntil.get(route) ?? 0) - Date.now();
      if (wait > 0) {
        if (wait > MAX_WAIT_MS) throw new DiscordHttpError(429, undefined, "rate limited");
        await this.sleep(wait);
      }

      const response = await this.fetch(
        new Request(url, {
          method,
          headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }),
      );
      this.track(route, response);
      const data = await readJson(response);

      if (response.ok) return data;
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = retryAfterMs(response, data);
        if (retryAfter <= MAX_WAIT_MS) {
          await this.sleep(retryAfter);
          continue;
        }
      }
      throw new DiscordHttpError(response.status, errorCode(data), errorMessage(data, response.statusText));
    }
  }

  private track(route: string, response: Response): void {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAfter = Number(response.headers.get("x-ratelimit-reset-after"));
    if (remaining === "0" && Number.isFinite(resetAfter)) this.blockedUntil.set(route, Date.now() + resetAfter * 1000);
    else this.blockedUntil.delete(route);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null && key in data ? Reflect.get(data, key) : undefined;
}

function retryAfterMs(response: Response, data: unknown): number {
  const seconds = Number(field(data, "retry_after") ?? response.headers.get("retry-after") ?? 1);
  return Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000);
}

function errorCode(data: unknown): number | undefined {
  const code = field(data, "code");
  return typeof code === "number" ? code : undefined;
}

function errorMessage(data: unknown, fallback: string): string {
  const message = field(data, "message");
  return typeof message === "string" ? message.slice(0, 200) : fallback;
}
