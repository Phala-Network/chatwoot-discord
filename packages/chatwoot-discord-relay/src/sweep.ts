import { DurableObject } from "cloudflare:workers";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore } from "../../../shared/store.ts";
import { relaysInbox } from "./config.ts";
import { control, conversation } from "./control.ts";
import type { Env } from "./env.ts";
import { loadSettings } from "./settings.ts";

export class AccountSweep extends DurableObject<Env> {
  private readonly store = new QueueStore(this.ctx.storage.sql);
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store.migrate();
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS roster (id INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY)",
    );
  }

  register(accountId: number, conversationId: number): void {
    this.bind(accountId);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO roster VALUES (?)", conversationId);
  }

  async request(accountId: number, full = false): Promise<void> {
    this.bind(accountId);
    if (full) this.store.set("full", "1");
    this.store.enqueue("sweep", 0, "{}");
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  private bind(accountId: number): void {
    const owner = this.store.get("account");
    if (owner && Number(owner) !== accountId) throw new Error("Sweep owner mismatch");
    this.store.set("account", String(accountId));
  }

  override async alarm(): Promise<void> {
    const job = this.store.nextDueJob();
    if (!job) return;
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.relay.subrequestBudget);
    budget.startSlice();
    const accountId = Number(this.store.get("account"));
    const account = settings.account(accountId);
    if (!account) return;
    const chatwoot = chatwootClient(
      settings.config.chatwoot.baseUrl,
      settings.secrets.CHATWOOT_RELAY_TOKEN,
      budget.fetch,
      this.store,
    );
    try {
      // Persist each delivery before RPC. A lost response repeats only the child's idempotent enqueue.
      let deliveries = this.ctx.storage.sql
        .exec<{ id: number }>("SELECT id FROM deliveries ORDER BY id LIMIT 12")
        .toArray();
      if (deliveries.length === 0) {
        const now = Date.now();
        const last = Number(this.store.get("last") ?? 0);
        const { lookbackSeconds, maxCatchUpSeconds } = settings.config.reconcile;
        const window = Math.min(
          Math.max(last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds, lookbackSeconds),
          maxCatchUpSeconds,
        );
        const scan: { page: number; cutoff: number; done: boolean; startedAt: number } = JSON.parse(
          this.store.get("scan") ?? "null",
        ) ?? { page: 1, cutoff: this.store.get("full") ? 0 : now / 1000 - window, done: false, startedAt: now };
        const cutoff = scan.cutoff;
        const items = scan.done ? [] : await chatwoot.listConversations(accountId, scan.page);
        for (const item of items)
          if (
            item.id &&
            (item.messages?.some((message) => message.id !== undefined) ||
              this.ctx.storage.sql.exec("SELECT 1 FROM roster WHERE id=?", item.id).toArray().length) &&
            relaysInbox(account, item.inbox_id) &&
            (item.last_activity_at ?? 0) >= cutoff
          )
            this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deliveries VALUES (?)", item.id);
        const ended = items.length === 0 || items.some((item) => (item.last_activity_at ?? 0) < cutoff);
        const wasDone = scan.done;
        scan.done ||= ended;
        scan.page += 1;
        this.store.set("scan", JSON.stringify(scan));
        const after = Number(this.store.get("roster:after") ?? 0);
        const known = wasDone
          ? []
          : this.ctx.storage.sql
              .exec<{ id: number }>("SELECT id FROM roster WHERE id > ? ORDER BY id LIMIT 12", after)
              .toArray();
        for (const item of known) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deliveries VALUES (?)", item.id);
        this.store.set("roster:after", String(known.length < 12 ? 0 : (known.at(-1)?.id ?? 0)));
        deliveries = this.ctx.storage.sql
          .exec<{ id: number }>("SELECT id FROM deliveries ORDER BY id LIMIT 12")
          .toArray();
      }
      for (let start = 0; start < deliveries.length; start += 3) {
        budget.checkpoint();
        if (budget.remaining < 3) break;
        await Promise.all(
          deliveries.slice(start, start + 3).map(async (item) => {
            try {
              await control(budget, () =>
                conversation(this.env, accountId, item.id).enqueueConversation(accountId, item.id),
              );
              this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE id = ?", item.id);
            } catch (error) {
              log.warn("sweep delivery delayed", { accountId, conversationId: item.id, ...errorFields(error) });
            }
          }),
        );
      }
      const scan: { done: boolean; startedAt: number } | null = JSON.parse(this.store.get("scan") ?? "null");
      if (!scan?.done || this.ctx.storage.sql.exec("SELECT 1 FROM deliveries LIMIT 1").toArray().length)
        this.store.deferJob(job);
      else {
        this.store.set("last", String(scan.startedAt));
        this.store.delete("scan");
        this.store.delete("full");
        this.store.completeJob(job);
      }
    } catch (error) {
      log.warn("account sweep delayed", { accountId, ...errorFields(error) });
      this.store.deferJob(job, 5000);
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }
}
