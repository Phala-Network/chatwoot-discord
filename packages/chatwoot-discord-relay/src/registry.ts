import { DurableObject } from "cloudflare:workers";
import {
  type RESTGetAPIChannelResult,
  type RESTGetAPIChannelWebhooksResult,
  type RESTGetCurrentApplicationResult,
  type RESTPostAPIChannelWebhookResult,
  Routes,
  WebhookType,
} from "discord-api-types/v10";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import { Budget } from "../../../shared/budget.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore } from "../../../shared/store.ts";
import type { Cache } from "./discord/forum.ts";
import { DiscordLimiter } from "./discord/limiter.ts";
import { DiscordHttpError, DiscordRest } from "./discord/rest.ts";
import { Effects } from "./effects.ts";
import type { Env } from "./env.ts";
import { loadSettings } from "./settings.ts";

export interface ForumSnapshot {
  id: string;
  token: string;
  guildId: string;
  version: number;
}
export interface ForumAccess {
  lookup(forumId: string): Promise<ForumSnapshot | null>;
  invalidate(forumId: string, version: number): Promise<void>;
}

/** Only Registry alarms discover resources; UNKNOWN creation may be resolved by resource identity. */
export async function discoverForum(rest: DiscordRest, store: Cache, forumId: string): Promise<ForumSnapshot | null> {
  const [application, channel, hooks] = await Promise.all([
    rest.get<RESTGetCurrentApplicationResult>(Routes.currentApplication()),
    rest.get<RESTGetAPIChannelResult>(Routes.channel(forumId)),
    rest.get<RESTGetAPIChannelWebhooksResult>(Routes.channelWebhooks(forumId)),
  ]);
  if (!("guild_id" in channel) || !channel.guild_id) throw new Error("Forum has no guild");
  let webhook = hooks.find(
    (hook) => hook.type === WebhookType.Incoming && hook.application_id === application.id && hook.token,
  );
  if (!webhook) {
    const effects = new Effects(store);
    let generation = Number(store.get("creation:generation") ?? 0);
    const previous = effects.read<RESTPostAPIChannelWebhookResult>(`webhook:${forumId}:${generation}`);
    // Only this fresh successful list can prove a known resource was deleted. UNKNOWN
    // creation without a receipt keeps its original guard and cannot authorize another POST.
    if (
      previous?.state === "CONFIRMED" &&
      previous.receipt &&
      !hooks.some((hook) => hook.id === previous.receipt?.id)
    ) {
      generation++;
      store.set("creation:generation", String(generation));
    }
    const effect = await effects.run(`webhook:${forumId}:${generation}`, { name: "Chatwoot" }, (frozen) =>
      rest.post<RESTPostAPIChannelWebhookResult, typeof frozen>(Routes.channelWebhooks(forumId), { body: frozen }),
    );
    if (effect.state !== "CONFIRMED") return null;
    webhook = effect.receipt;
  }
  if (!webhook?.token) throw new Error("Missing webhook credential");
  const version = Number(store.get("version") ?? 0) + 1;
  store.set("version", String(version));
  return { id: webhook.id, token: webhook.token, guildId: channel.guild_id, version };
}

export class ForumRegistry extends DurableObject<Env> {
  private readonly store = new QueueStore(this.ctx.storage.sql, Date.now, (write) =>
    this.ctx.storage.transactionSync(write),
  );
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store.migrate();
  }

  async lookup(forumId: string): Promise<ForumSnapshot | null> {
    const saved = this.store.get("ready");
    if (!saved) {
      this.store.enqueue("refresh", 0, forumId);
      await scheduleAlarm(this.ctx, this.store.nextWakeup());
    }
    return saved ? JSON.parse(saved) : null;
  }

  async invalidate(forumId: string, version: number): Promise<void> {
    const saved = this.store.get("ready");
    if (saved && (JSON.parse(saved) as ForumSnapshot).version !== version) return;
    this.store.delete("ready");
    this.store.enqueue("refresh", 0, forumId);
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  override async alarm(): Promise<void> {
    const job = this.store.nextDueJob();
    if (!job) return;
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.relay.subrequestBudget);
    budget.startSlice();
    const rest = new DiscordRest(
      settings.secrets.DISCORD_BOT_TOKEN,
      budget.fetch,
      new DiscordLimiter(this.store, this.env, budget),
    );
    try {
      const ready = await discoverForum(rest, this.store, job.payload);
      if (ready) {
        this.store.set("ready", JSON.stringify(ready));
        this.store.completeJob(job);
      } else this.store.deferJob(job, 5000);
    } catch (error) {
      log.warn("forum discovery delayed", { forumId: job.payload, ...errorFields(error) });
      this.store.deferJob(
        job,
        error instanceof DiscordHttpError && error.retryAfterMs !== undefined ? error.retryAfterMs : 1000,
      );
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }
}
