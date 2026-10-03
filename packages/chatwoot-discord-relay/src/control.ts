import { DurableObject } from "cloudflare:workers";
import { type LimitReport, LimitState, type Permit, type Reservation } from "./discord/limiter.ts";
import type { Env } from "./env.ts";

export { control, conversation } from "./rpc.ts";

export class LocalState {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  get<T>(key: string): T | undefined {
    const value = this.sql.exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key).toArray()[0]?.value;
    return value === undefined ? undefined : JSON.parse(value);
  }
  delete(key: string): void {
    this.sql.exec("DELETE FROM state WHERE key=?", key);
  }
  set(key: string, value: unknown): void {
    this.sql.exec(
      "INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
}

export interface ThreadOwner {
  accountId: number;
  conversationId: number;
  guildId: string;
  forumId: string;
  generation: number;
}

function sameOwner(a: ThreadOwner | null, b: ThreadOwner): boolean {
  return (
    a !== null &&
    a.accountId === b.accountId &&
    a.conversationId === b.conversationId &&
    a.guildId === b.guildId &&
    a.forumId === b.forumId &&
    a.generation === b.generation
  );
}

export class ThreadDirectory extends DurableObject<Env> {
  private readonly state = new LocalState(this.ctx.storage.sql);

  get(): ThreadOwner | null {
    return this.state.get<ThreadOwner>("owner") ?? null;
  }

  claim(owner: ThreadOwner): boolean {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.get();
      if (this.state.get("tombstone")) return false;
      if (existing) return sameOwner(existing, owner);
      this.state.set("owner", owner);
      return true;
    });
  }

  tombstone(owner: ThreadOwner): boolean {
    if (!sameOwner(this.get(), owner)) return false;
    this.state.set("tombstone", true);
    this.state.set("owner", null);
    return true;
  }
}

export class TriageBudget extends DurableObject<Env> {
  private readonly state = new LocalState(this.ctx.storage.sql);

  reserve(hour: string, event: string, limit: number): boolean {
    if (hour !== new Date().toISOString().slice(0, 13)) return false;
    return this.ctx.storage.transactionSync(() => {
      const decision = this.state.get<boolean>(event);
      if (decision !== undefined) return decision;
      const count = this.state.get<number>("count") ?? 0;
      const granted = count < limit;
      this.state.set(event, granted);
      if (granted) this.state.set("count", count + 1);
      return granted;
    });
  }
}

export class DiscordRateLimit extends DurableObject<Env> {
  private readonly limits = new LimitState(new LocalState(this.ctx.storage.sql));
  reserve(request: Reservation): Permit {
    return this.ctx.storage.transactionSync(() => this.limits.reserve(request));
  }
  report(report: LimitReport): void {
    this.ctx.storage.transactionSync(() => this.limits.report(report));
  }
}
