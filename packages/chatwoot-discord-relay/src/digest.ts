import { DurableObject } from "cloudflare:workers";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore } from "../../../shared/store.ts";
import { DiscordLimiter } from "./discord/limiter.ts";
import { DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import { escalationsSchema, postQueue } from "./queue.ts";
import { loadSettings } from "./settings.ts";

export class QueueDigest extends DurableObject<Env> {
  private readonly store = new QueueStore(this.ctx.storage.sql, Date.now, (write) =>
    this.ctx.storage.transactionSync(write),
  );
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store.migrate();
  }
  stage(epoch: string, escalations: string): void {
    escalationsSchema.parse(JSON.parse(escalations));
    const saved = this.store.get("adoption:epoch");
    if (saved && saved !== epoch) throw new Error("Digest epoch conflict");
    if (!saved) {
      this.store.set("queue:escalations", escalations);
      this.store.set("adoption:epoch", epoch);
    }
  }
  async request(hour: number): Promise<void> {
    this.store.enqueue(`queue:${hour}`, 0, JSON.stringify(hour), hour);
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }
  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    if (settings.config.cutover?.phase === "maintenance") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const job = this.store.nextDueJob();
    if (!job) return;
    const now: number = JSON.parse(job.payload);
    if (now < (settings.config.cutover?.notificationsAfter ?? 0)) {
      this.store.completeJob(job);
      await scheduleAlarm(this.ctx, this.store.nextWakeup());
      return;
    }
    const budget = new Budget(settings.config.relay.subrequestBudget);
    budget.startSlice();
    const rest = new DiscordRest(
      settings.secrets.DISCORD_BOT_TOKEN,
      budget.fetch,
      new DiscordLimiter(this.store, this.env, budget),
    );
    const chatwoot = chatwootClient(
      settings.config.chatwoot.baseUrl,
      settings.secrets.CHATWOOT_RELAY_TOKEN,
      budget.fetch,
      this.store,
    );
    try {
      if ((await postQueue({ settings, store: this.store, rest, chatwoot, budget }, now, now + 180_000)) === "done")
        this.store.completeJob(job);
      else this.store.deferJob(job);
    } catch (error) {
      log.warn("queue digest delayed", errorFields(error));
      this.store.deferJob(job, 5000);
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }
}
