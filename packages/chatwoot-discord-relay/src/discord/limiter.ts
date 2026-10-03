// Local control transactions only. Callers reserve, fetch directly, then durably report headers.

import { within } from "../../../../shared/deadline.ts";
import type { RateLimitStore } from "../../../../shared/rate-limit.ts";

interface ControlBudget {
  consume(): void;
  require(requests: number): void;
  controlSignal(ms: number): AbortSignal;
}
interface LimiterBindings {
  DISCORD_RATE_LIMIT: {
    getByName(name: string): {
      reserve(request: Reservation): Promise<Permit>;
      report(report: LimitReport): Promise<void>;
    };
  };
}

interface State {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
interface Window {
  remaining: number;
  capacity: number;
  durationMs: number;
  until: number;
  notBefore: number;
}
export interface Reservation {
  id: string;
  createdAt: number;
  route: string;
  credential: string;
  global: boolean;
}
export type Permit = { allowed: true; validForMs: number } | { allowed: false; retryAfterMs: number };
export interface LimitReport {
  owner: string;
  reservation: Reservation;
  bucket?: string;
  scope?: string;
  remaining?: number;
  capacity?: number;
  resetAfterMs: number;
  retryAfterMs: number;
  global: boolean;
}
const PERMIT_MS = 100;

/** The same mechanism is used by every major and global owner. Reports only tighten a window. */
export class LimitState {
  private readonly state: State;
  constructor(state: State) {
    this.state = state;
  }

  reserve(request: Reservation): Permit {
    const now = Date.now();
    this.prune(now);
    if (request.createdAt < now - 60_000 || request.createdAt > now + 1000)
      return { allowed: false, retryAfterMs: 1000 };
    const saved = this.state.get<{ at: number; permit: Permit }>(`reservation:${request.id}`);
    if (saved) return now - saved.at < PERMIT_MS ? saved.permit : { allowed: false, retryAfterMs: 1000 };
    const key = this.bucket(request);
    let window = this.state.get<Window>(key);
    if (!window || (window.until <= now && window.notBefore <= now)) {
      // Unknown routes get one probe; global covers both request and dispatch-permit lifetime.
      const durationMs = request.global ? 1000 + PERMIT_MS : (window?.durationMs ?? 0);
      const capacity = request.global ? 50 : window?.durationMs ? window.capacity : 1;
      window = { remaining: capacity, capacity, durationMs, until: now + (durationMs || 1000), notBefore: 0 };
    }
    const attempts = request.global
      ? (this.state.get<number[]>("attempts") ?? []).filter((at) => at + 1000 + PERMIT_MS > now)
      : [];
    const cooldown = Math.max(
      window.notBefore,
      request.global
        ? attempts.length >= 50
          ? (attempts[0] ?? now) + 1000 + PERMIT_MS
          : 0
        : window.remaining <= 0
          ? window.until
          : 0,
    );
    const permit: Permit =
      cooldown > now ? { allowed: false, retryAfterMs: cooldown - now } : { allowed: true, validForMs: PERMIT_MS };
    if (permit.allowed) {
      window.remaining -= 1;
      if (request.global) this.state.set("attempts", [...attempts, now]);
    }
    this.state.set(key, window);
    this.state.set(`reservation:${request.id}`, { at: now, permit });
    this.retain(`reservation:${request.id}`, now + 60_000);
    return permit;
  }

  report(report: LimitReport): void {
    const receiptKey = `report:${report.reservation.id}`;
    if (this.state.get(receiptKey)) return;
    this.state.set(receiptKey, true);
    this.retain(receiptKey, Date.now() + Math.max(60_000, report.retryAfterMs + report.resetAfterMs));
    const request = report.reservation;
    const oldKey = this.bucket(request);
    if (report.bucket) {
      const previous = this.state.get<{ bucket: string; scope: string }>(`alias:${request.route}`);
      // Scope is only guaranteed on 429 responses. A concurrent 2xx cannot erase a known
      // shared resource cooldown by omitting that header.
      this.state.set(`alias:${request.route}`, {
        bucket: report.bucket,
        scope: report.scope ?? previous?.scope ?? "user",
      });
    }
    const key = this.bucket(request);
    const now = Date.now();
    const old = this.state.get<Window>(oldKey);
    const current = this.state.get<Window>(key);
    const window: Window = {
      capacity: report.capacity ?? current?.capacity ?? Math.max(1, report.remaining ?? 1),
      durationMs: Math.max(current?.durationMs ?? 0, old?.durationMs ?? 0, report.resetAfterMs),
      remaining: Math.min(current?.remaining ?? report.remaining ?? 0, report.remaining ?? current?.remaining ?? 0),
      until: Math.max(current?.until ?? 0, oldKey === key ? (old?.until ?? 0) : 0, now + report.resetAfterMs),
      notBefore: Math.max(
        current?.notBefore ?? 0,
        old?.notBefore ?? 0,
        report.retryAfterMs > 0 ? now + report.retryAfterMs : 0,
      ),
    };
    this.state.set(key, window);
  }

  private retain(key: string, expiresAt: number): void {
    const receipts = this.state.get<Array<{ key: string; expiresAt: number }>>("receipts") ?? [];
    this.state.set("receipts", [...receipts, { key, expiresAt }]);
  }

  private prune(now: number): void {
    const receipts = this.state.get<Array<{ key: string; expiresAt: number }>>("receipts") ?? [];
    for (const receipt of receipts) if (receipt.expiresAt <= now) this.state.delete(receipt.key);
    this.state.set(
      "receipts",
      receipts.filter((receipt) => receipt.expiresAt > now),
    );
  }

  private bucket(request: Reservation): string {
    if (request.global) return "global";
    const alias = this.state.get<{ bucket: string; scope: string }>(`alias:${request.route}`);
    return `bucket:${alias?.scope === "shared" ? "shared" : request.credential}:${alias?.bucket ?? request.route}`;
  }
}

export async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class DiscordLimiter {
  private readonly local = new Map<string, LimitState>();
  private readonly store: RateLimitStore;
  private readonly env: LimiterBindings | undefined;
  private readonly budget: ControlBudget | undefined;
  constructor(store: RateLimitStore, env?: LimiterBindings, budget?: ControlBudget) {
    this.store = store;
    this.env = env;
    this.budget = budget;
  }

  private control<T>(call: () => Promise<T>): Promise<T> {
    this.budget?.consume();
    return within(call(), this.budget?.controlSignal(200) ?? AbortSignal.timeout(200));
  }

  private owner(name: string) {
    if (this.env) {
      const stub = this.env.DISCORD_RATE_LIMIT.getByName(name);
      return {
        reserve: (request: Reservation) => this.control<Permit>(async () => await stub.reserve(request)),
        report: (report: LimitReport) => this.control(() => stub.report(report)),
      };
    }
    let limits = this.local.get(name);
    if (!limits) {
      limits = new LimitState({
        get: <T>(key: string): T | undefined => {
          const saved = this.store.get(`limit:${name}:${key}`);
          return saved ? JSON.parse(saved) : undefined;
        },
        set: (key, value) => this.store.set(`limit:${name}:${key}`, JSON.stringify(value)),
        delete: (key) => this.store.set(`limit:${name}:${key}`, "", 0),
      });
      this.local.set(name, limits);
    }
    return {
      reserve: async (request: Reservation) => limits.reserve(request),
      report: async (report: LimitReport) => limits.report(report),
    };
  }

  async reserve(method: string, path: string, token: string, auth: boolean, interaction: boolean) {
    const resource = /^\/(channels|guilds|webhooks)\/([^/]+)/.exec(path);
    const owner = resource ? `${resource[1]}:${resource[2]}` : `route:${path}`;
    const route = `${method}:${path
      .replace(/^\/(channels|guilds)\/[^/]+/, "/$1/:major")
      .replace(/^\/webhooks\/[^/]+\/[^/]+/, "/webhooks/:major/:token")
      .replace(/\/messages\/[^/]+/, "/messages/:id")}`;
    const credential = await fingerprint(auth ? token : (path.split("/")[3] ?? "unauth"));
    const globalOwner = interaction ? undefined : auth ? `global:bot:${credential}` : "global:unauth:installation";
    if (!(await this.flush(globalOwner ? [owner, globalOwner] : [owner])))
      return { allowed: false as const, retryAfterMs: 1000 };
    // Reserve room for both controls, HTTP and cooldown reports before dispatch.
    this.budget?.require(interaction ? 3 : 5);
    const reservation: Reservation = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      route,
      credential,
      global: false,
    };
    const started = performance.now();
    const permit = await this.owner(owner).reserve(reservation);
    if (!permit.allowed) return { allowed: false as const, retryAfterMs: permit.retryAfterMs };
    let globalPermit: Permit | undefined;
    if (globalOwner) {
      globalPermit = await this.owner(globalOwner).reserve({ ...reservation, global: true });
      if (!globalPermit.allowed) return { allowed: false as const, retryAfterMs: globalPermit.retryAfterMs };
    }
    if (
      performance.now() - started >=
      Math.min(permit.validForMs, globalPermit?.allowed ? globalPermit.validForMs : PERMIT_MS)
    )
      return { allowed: false as const, retryAfterMs: 1000 };
    return { allowed: true as const, owner, globalOwner, reservation };
  }

  async report(report: LimitReport, globalOwner?: string): Promise<void> {
    const reports: LimitReport[] = JSON.parse(this.store.get("discord:reports") ?? "[]");
    reports.push(report);
    if (globalOwner && report.global)
      reports.push({ ...report, owner: globalOwner, bucket: "", reservation: { ...report.reservation, global: true } });
    this.store.set("discord:reports", JSON.stringify(reports));
    for (const owner of globalOwner && report.global ? [report.owner, globalOwner] : [report.owner]) {
      try {
        await this.flush([owner]);
      } catch {
        /* The durable report fences this domain's next attempt, not independent domains. */
      }
    }
  }

  private async flush(owners: string[]): Promise<boolean> {
    const reports: LimitReport[] = JSON.parse(this.store.get("discord:reports") ?? "[]");
    // A finite batch yields before a report backlog can occupy an alarm or feedback path.
    for (const report of reports.filter((item) => owners.includes(item.owner)).slice(0, 3)) {
      await this.owner(report.owner).report(report);
      const current: LimitReport[] = JSON.parse(this.store.get("discord:reports") ?? "[]");
      this.store.set(
        "discord:reports",
        JSON.stringify(
          current.filter((item) => item.owner !== report.owner || item.reservation.id !== report.reservation.id),
        ),
      );
    }
    const remaining: LimitReport[] = JSON.parse(this.store.get("discord:reports") ?? "[]");
    return !remaining.some((item) => owners.includes(item.owner));
  }
}
