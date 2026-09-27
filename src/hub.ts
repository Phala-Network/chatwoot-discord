// The single Durable Object that owns all state and does all background work.
//
// Requests (webhook events, deferred commands, sweeps) only write a job row and set an
// alarm, so they return quickly. The alarm drains due jobs one at a time, which serializes work
// per conversation (and globally), and yields to a fresh invocation before it would exceed the
// per-invocation subrequest limit. Failed jobs back off and retry, and are dropped after
// MAX_JOB_ATTEMPTS (rate limits do not count); nothing depends on a single delivery succeeding.

import { DurableObject } from "cloudflare:workers";
import {
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageResult,
  Routes,
} from "discord-api-types/v10";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "./budget.ts";
import { chatwootClient, toRelayConversation } from "./chatwoot/api.ts";
import { executeCommand } from "./commands/actions.ts";
import { type CommandJob, commandJobSchema } from "./commands/job.ts";
import { loadSettings, relaysInbox, type Settings } from "./config.ts";
import { DiscordForum } from "./discord/forum.ts";
import { DiscordHttpError, DiscordRest } from "./discord/rest.ts";
import { errorFields, log } from "./log.ts";
import { latestMessageId, processConversation, processMessageUpdate, relayFor } from "./relay/processor.ts";
import type { Relay } from "./relay/relay.ts";
import { type Job, Store } from "./store.ts";

export const HUB_NAME = "global";

const id = z.number().int().positive();
const payloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), job: commandJobSchema }),
  z.object({ type: z.literal("sweep"), accountId: id }),
  z.object({ type: z.literal("conversation"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("message-updated"), accountId: id, conversationId: id, messageId: id }),
]);
type JobPayload = z.infer<typeof payloadSchema>;

const PRIORITY = { command: 0, sweep: 1, conversation: 2, "message-updated": 3 } as const;
/** Requests a job may need before it can start without being cut short. */
const COMMAND_BUDGET = 20;
const MIN_BUDGET = 2;
/** Pages of conversations (25 each by default) a sweep reads at most. */
const SWEEP_PAGES = 10;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
/**
 * A job that fails this often is dropped (after about 70 minutes of backoff), so a persistent
 * failure stops holding the queue. The sweep queues conversations that are still behind again,
 * and the next webhook for one starts a new job without backoff.
 */
const MAX_JOB_ATTEMPTS = 10;
/** Stop draining and continue in a new invocation after this long (alarms may run 15 minutes). */
const RUN_WALL_MS = 5 * 60 * 1000;
/**
 * Discord interaction tokens are valid for 15 minutes. A command that cannot start within this
 * time is dropped, and the invoker is told while the token still works: running it later could
 * not report its result, and the invoker may already have acted in Chatwoot, so running it
 * could, for example, send a reply twice.
 */
const COMMAND_START_DEADLINE_MS = 12 * 60 * 1000;
const EXPIRED = "❌ This could not start in time, so nothing was done. Please try again.";

export class Hub extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => this.store.migrate());
  }

  /** Queues a conversation for syncing, at the earliest after `delayMs`. */
  async enqueueConversation(accountId: number, conversationId: number, delayMs = 0): Promise<void> {
    this.enqueue({ type: "conversation", accountId, conversationId }, Date.now() + delayMs);
    await this.schedule();
  }

  /**
   * Queues a check of a message reported as deleted (its Discord messages are removed), as
   * answered by the customer (the response is posted), or as not delivered (a notice is posted).
   */
  async enqueueMessageUpdate(accountId: number, conversationId: number, messageId: number): Promise<void> {
    this.enqueue({ type: "message-updated", accountId, conversationId, messageId });
    await this.schedule();
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

  /** Cloudflare runs at most one alarm() at a time per Durable Object. */
  override async alarm(): Promise<void> {
    await this.drain();
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
        log.warn("unreadable job dropped", { job: job.key });
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
          if (Date.now() - job.createdAt > COMMAND_START_DEADLINE_MS) {
            log.warn("command expired before it could run; dropped", {
              interactionId: payload.job.interactionId,
              action: payload.job.action.type,
            });
            await respond(services.rest, payload.job, EXPIRED);
            return "done";
          }
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
        case "message-updated":
          await processMessageUpdate(services, payload.accountId, payload.conversationId, payload.messageId);
          this.store.completeJob(job);
          return "done";
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) return "yield";
      const backoff = Math.min(5000 * 2 ** job.attempts, MAX_BACKOFF_MS);
      if (error instanceof DiscordHttpError && error.retryAfterMs !== undefined) {
        // Rate limited: wait as long as Discord asks without counting an attempt, so no rate
        // limit, however long, drops the job.
        const delay = Math.max(backoff, error.retryAfterMs);
        log.warn("job rate limited by Discord; will retry", { job: job.key, delayMs: delay });
        this.store.deferJob(job, delay);
        return "done";
      }
      if (job.attempts + 1 >= MAX_JOB_ATTEMPTS) {
        log.error("job failed too often; dropped", { job: job.key, attempts: job.attempts + 1, ...errorFields(error) });
        this.store.deleteJob(job.key);
        return "done";
      }
      // Transient failures are warnings; a job that keeps failing is an error.
      const logAt = job.attempts + 1 >= 3 ? log.error : log.warn;
      logAt("job failed; will retry", {
        job: job.key,
        attempts: job.attempts + 1,
        delayMs: backoff,
        ...errorFields(error),
      });
      this.store.retryJob(job, backoff);
      return "done";
    }
  }

  private async runCommand(job: CommandJob, services: Services): Promise<void> {
    const { content, conversationGone } = await executeCommand(job, services.settings, services.budget.fetch);
    // Chatwoot sends no webhook when a conversation is deleted: let its job close the post.
    if (conversationGone)
      this.enqueue({ type: "conversation", accountId: job.accountId, conversationId: job.conversationId });
    await respond(services.rest, job, content);
  }

  /**
   * Finds conversations whose post is behind (new messages, or tags/status/archive state that
   * differ) and queues them. Covers webhooks that were never delivered and service downtime.
   * Reads conversations newest activity first and stops at the window's start. Activity means a
   * new message (Chatwoot's `last_activity_at`); a change that creates none, such as only a
   * custom attribute, relies on its webhook.
   */
  private async sweep(accountId: number, { settings, chatwoot, relay }: Services): Promise<void> {
    const key = `sweep:${accountId}:last`;
    const last = Number(this.store.get(key) ?? 0);
    const now = Date.now();
    const { lookbackSeconds, maxCatchUpSeconds } = settings.config.reconcile;
    const sinceLast = last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds;
    const window = Math.min(Math.max(sinceLast, lookbackSeconds), maxCatchUpSeconds);
    const cutoff = now / 1000 - window;

    const account = settings.account(accountId);
    let seen = 0;
    let queued = 0;
    let reachedCutoff = false;
    /** Unix seconds of the oldest activity read. */
    let oldest = now / 1000;
    for (let page = 1; page <= SWEEP_PAGES && !reachedCutoff; page += 1) {
      const conversations = await chatwoot.listConversations(accountId, page);
      if (conversations.length === 0) reachedCutoff = true;
      for (const conversation of conversations) {
        const activity = conversation.last_activity_at ?? 0;
        if (activity < cutoff) {
          reachedCutoff = true;
          break;
        }
        oldest = Math.min(oldest, activity);
        const conversationId = conversation.id;
        if (conversationId === undefined || !account || !relaysInbox(account, conversation.inbox_id)) continue;
        seen += 1;
        const row = this.store.conversation(accountId, conversationId);
        const latest = latestMessageId(conversation);
        // An adopted post without a cursor needs one run to pick its starting point.
        const needsCursor = row?.threadId !== undefined && row.cursor === undefined;
        const cursor = row?.cursor ?? settings.config.relay.startAfterMessageId;
        const behind = needsCursor || (latest !== undefined && latest > cursor);
        const stale =
          row?.threadId !== undefined && row.state !== relay.stateOf(toRelayConversation(conversationId, conversation));
        if (behind || stale) {
          this.enqueue({ type: "conversation", accountId, conversationId });
          queued += 1;
        }
      }
    }
    // Stopped at the page limit: the next sweep continues back from the oldest activity read.
    if (!reachedCutoff) log.warn("sweep stopped at its page limit", { accountId, pages: SWEEP_PAGES });
    this.store.set(key, String(reachedCutoff ? now : Math.floor(oldest * 1000)));
    log.info("sweep done", { accountId, windowSeconds: Math.round(window), seen, queued });
  }

  private services(settings: Settings, budget: Budget): Services {
    const rest = new DiscordRest(settings.secrets.DISCORD_BOT_TOKEN, budget.fetch);
    const chatwoot = chatwootClient(
      settings.config.chatwoot.baseUrl,
      settings.secrets.CHATWOOT_RELAY_TOKEN,
      budget.fetch,
    );
    const forum = new DiscordForum(rest, this.store);
    const relay = relayFor(settings, forum, this.store);
    return { settings, store: this.store, relay, forum, chatwoot, budget, rest };
  }

  private enqueue(payload: JobPayload, notBefore?: number): void {
    const key =
      payload.type === "command"
        ? `command:${payload.job.interactionId}`
        : payload.type === "sweep"
          ? `sweep:${payload.accountId}`
          : payload.type === "conversation"
            ? `conversation:${payload.accountId}:${payload.conversationId}`
            : `${payload.type}:${payload.accountId}:${payload.conversationId}:${payload.messageId}`;
    this.store.enqueue(key, PRIORITY[payload.type], JSON.stringify(payload), notBefore);
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

/** Replaces the invoker's "thinking…" with `content`. */
async function respond(rest: DiscordRest, job: CommandJob, content: string): Promise<void> {
  try {
    await rest.patch<RESTPatchAPIWebhookWithTokenMessageResult, RESTPatchAPIWebhookWithTokenMessageJSONBody>(
      Routes.webhookMessage(job.applicationId, job.token, "@original"),
      { body: { content, allowed_mentions: { parse: [] } }, auth: false },
    );
  } catch (error) {
    log.error("command follow-up failed", { interactionId: job.interactionId, ...errorFields(error) });
  }
}

function minimumBudget(payload: JobPayload): number {
  if (payload.type === "command") return COMMAND_BUDGET;
  return payload.type === "sweep" ? SWEEP_PAGES : MIN_BUDGET;
}

/** A stored job, or undefined for one that is unreadable or of an unknown kind. */
function parsePayload(raw: string): JobPayload | undefined {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
