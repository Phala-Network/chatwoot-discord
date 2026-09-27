// The single Durable Object that owns all state and does all background work.
//
// Requests (webhook events, deferred commands, sweeps, imports) only write a job row and set an
// alarm, so they return quickly. The alarm drains due jobs one at a time, which serializes work
// per conversation (and globally), and yields to a fresh invocation before it would exceed the
// per-invocation subrequest limit. Failed jobs back off and retry; nothing depends on a single
// delivery succeeding.

import { DurableObject } from "cloudflare:workers";
import { type RESTPatchAPIWebhookWithTokenMessageJSONBody, Routes } from "discord-api-types/v10";
import { Budget, BudgetExhaustedError } from "./budget.js";
import { ChatwootError, chatwootClient, toRelayConversation } from "./chatwoot/api.js";
import { executeCommand } from "./commands/actions.js";
import type { CommandJob } from "./commands/job.js";
import { loadSettings, type Settings } from "./config.js";
import { DiscordForum } from "./discord/forum.js";
import { DiscordRest } from "./discord/rest.js";
import { errorFields, log } from "./log.js";
import { latestMessageId, processConversation } from "./relay/processor.js";
import { Relay } from "./relay/relay.js";
import { type Job, Store } from "./store.js";

export const HUB_NAME = "global";

type JobPayload =
  | { type: "command"; job: CommandJob }
  | { type: "sweep"; accountId: number }
  | { type: "conversation"; accountId: number; conversationId: number };

const PRIORITY = { command: 0, sweep: 1, conversation: 2 } as const;
/** Requests a job may need before it can start without being cut short. */
const COMMAND_BUDGET = 20;
const SWEEP_BUDGET = 2;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
/** Stop draining and continue in a new invocation after this long (alarms may run 15 minutes). */
const RUN_WALL_MS = 5 * 60 * 1000;

export class Hub extends DurableObject<Env> {
  private readonly store: Store;
  /** Guards against overlapping drains (e.g. an alarm invoked while another is still running). */
  private draining = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => this.store.migrate());
  }

  /** Queues a conversation for syncing. Returns "duplicate" for an already-seen webhook delivery. */
  async enqueueConversation(
    accountId: number,
    conversationId: number,
    deliveryId?: string,
  ): Promise<"queued" | "duplicate"> {
    if (deliveryId && !this.store.recordDelivery(deliveryId)) return "duplicate";
    this.enqueue({ type: "conversation", accountId, conversationId });
    await this.schedule();
    return "queued";
  }

  async enqueueCommand(job: CommandJob): Promise<void> {
    this.enqueue({ type: "command", job });
    await this.schedule();
  }

  /** Queues a reconciliation sweep for every configured account (called by the cron trigger). */
  async requestSweep(): Promise<void> {
    for (const account of loadSettings(this.env).config.accounts)
      this.enqueue({ type: "sweep", accountId: account.id });
    await this.schedule();
  }

  async ticketForThread(threadId: string): Promise<{ accountId: number; conversationId: number } | null> {
    return this.store.ticketForThread(threadId) ?? null;
  }

  override async alarm(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drain();
    } finally {
      this.draining = false;
    }
  }

  private async drain(): Promise<void> {
    const settings = loadSettings(this.env);
    const budget = new Budget(settings.config.relay.subrequestBudget);
    const services = this.services(settings, budget);
    const startedAt = Date.now();
    let yielded = false;

    this.store.prune();
    for (let job = this.store.nextDueJob(); job; job = this.store.nextDueJob()) {
      const payload = parsePayload(job.payload);
      if (!payload) {
        this.store.deleteJob(job.key);
        continue;
      }
      if (budget.remaining < minimumBudget(payload) || Date.now() - startedAt > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      const outcome = await this.run(job, payload, services);
      if (outcome === "yield") {
        this.store.deferJob(job);
        yielded = true;
        break;
      }
    }
    await this.schedule(yielded ? Date.now() : undefined);
  }

  private async run(job: Job, payload: JobPayload, services: Services): Promise<"done" | "yield"> {
    try {
      switch (payload.type) {
        case "command":
          // At most once: a command that sends a message must never run twice.
          this.store.deleteJob(job.key);
          await this.runCommand(payload.job, services);
          return "done";
        case "sweep":
          await this.sweep(payload.accountId, services);
          this.store.completeJob(job);
          return "done";
        case "conversation": {
          const outcome = await processConversation(services, payload.accountId, payload.conversationId);
          if (outcome === "done") this.store.completeJob(job);
          return outcome;
        }
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) return "yield";
      if (error instanceof ChatwootError && error.status === 404 && payload.type === "conversation") {
        log.warn("conversation not found; dropping job", {
          accountId: payload.accountId,
          conversationId: payload.conversationId,
        });
        this.store.deleteJob(job.key);
        return "done";
      }
      const delay = Math.min(5000 * 2 ** job.attempts, MAX_BACKOFF_MS);
      // Transient failures are warnings; a job that keeps failing is an error.
      const logAt = job.attempts + 1 >= 3 ? log.error : log.warn;
      logAt("job failed; will retry", {
        job: job.key,
        attempts: job.attempts + 1,
        delayMs: delay,
        ...errorFields(error),
      });
      this.store.retryJob(job, delay);
      return "done";
    }
  }

  private async runCommand(job: CommandJob, services: Services): Promise<void> {
    const content = await executeCommand(job, services.settings, services.budget.fetch);
    const body: RESTPatchAPIWebhookWithTokenMessageJSONBody = { content, allowed_mentions: { parse: [] } };
    try {
      await services.rest.patch(Routes.webhookMessage(job.applicationId, job.token, "@original"), {
        body,
        auth: false,
      });
    } catch (error) {
      log.error("command follow-up failed", { interactionId: job.interactionId, ...errorFields(error) });
    }
  }

  /**
   * Finds conversations whose post is behind (new messages, or tags/status/archive state that
   * differ) and queues them. Covers webhooks that were never delivered and service downtime.
   */
  private async sweep(accountId: number, { settings, chatwoot, relay }: Services): Promise<void> {
    const key = `sweep:${accountId}:last`;
    const last = Number(this.store.get(key) ?? 0);
    const now = Date.now();
    const { lookbackSeconds, maxCatchUpSeconds } = settings.config.reconcile;
    const sinceLast = last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds;
    const window = Math.min(Math.max(sinceLast, lookbackSeconds), maxCatchUpSeconds);

    const conversations = await chatwoot.listUpdatedConversations(accountId, window);
    let queued = 0;
    for (const conversation of conversations) {
      const row = this.store.conversation(accountId, conversation.id);
      const latest = latestMessageId(conversation);
      // An imported post without a cursor needs one run to pick its starting point.
      const needsCursor = row?.threadId !== undefined && row.cursor === undefined;
      const cursor = row?.cursor ?? settings.config.relay.startAfterMessageId;
      const behind = needsCursor || (latest !== undefined && latest > cursor);
      const stale = row?.threadId !== undefined && row.state !== relay.stateOf(toRelayConversation(conversation));
      if (behind || stale) {
        this.enqueue({ type: "conversation", accountId, conversationId: conversation.id });
        queued += 1;
      }
    }
    this.store.set(key, String(now));
    log.info("sweep done", { accountId, windowSeconds: Math.round(window), seen: conversations.length, queued });
  }

  private services(settings: Settings, budget: Budget): Services {
    const rest = new DiscordRest(settings.secrets.DISCORD_BOT_TOKEN, budget.fetch);
    const chatwoot = chatwootClient(
      settings.config.chatwoot.baseUrl,
      settings.secrets.CHATWOOT_RELAY_TOKEN,
      budget.fetch,
    );
    const linkAttribute = settings.config.relay.linkAttribute;
    const triageUserId = settings.config.triage.userId;
    const forum = new DiscordForum(rest, this.store);
    const relay = new Relay({
      forum,
      store: this.store,
      frontendUrl: settings.frontendUrl,
      target: (accountId) => {
        const account = settings.account(accountId);
        if (!account) throw new Error(`Account ${accountId} is not configured`);
        return { forumChannelId: account.forumChannelId, tag: account.tag ?? account.name };
      },
      topicAttribute: settings.config.relay.topicAttribute,
      maxChunks: settings.config.relay.maxChunks,
      ...(triageUserId ? { triage: { ...settings.config.triage, userId: triageUserId } } : {}),
      discordUserFor: (assignee) => settings.discordUserForEmail(assignee.email),
      ...(linkAttribute
        ? {
            linkPost: (accountId: number, conversationId: number, url: string) =>
              chatwoot.setCustomAttribute(accountId, conversationId, linkAttribute, url),
          }
        : {}),
      onIgnoredError: (error) => {
        log.error("could not link post from conversation", errorFields(error));
      },
    });
    return { settings, store: this.store, relay, forum, chatwoot, budget, rest };
  }

  private enqueue(payload: JobPayload): void {
    const key =
      payload.type === "command"
        ? `command:${payload.job.interactionId}`
        : payload.type === "sweep"
          ? `sweep:${payload.accountId}`
          : `conversation:${payload.accountId}:${payload.conversationId}`;
    this.store.enqueue(key, PRIORITY[payload.type], JSON.stringify(payload));
  }

  /** Sets the alarm for the earliest due job (or `at`), unless an earlier alarm is already set. */
  private async schedule(at?: number): Promise<void> {
    const next = at ?? this.store.nextWakeup();
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

interface Services {
  settings: Settings;
  store: Store;
  relay: Relay;
  forum: DiscordForum;
  chatwoot: ReturnType<typeof chatwootClient>;
  budget: Budget;
  rest: DiscordRest;
}

function minimumBudget(payload: JobPayload): number {
  return payload.type === "command" ? COMMAND_BUDGET : SWEEP_BUDGET;
}

function parsePayload(raw: string): JobPayload | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "type" in value) return value as JobPayload;
  } catch {
    // Fall through: an unreadable job is dropped.
  }
  return undefined;
}
