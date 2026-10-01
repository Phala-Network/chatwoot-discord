// The single Durable Object that owns all state and does all background work.
//
// Requests (webhook events, deferred commands, sweeps) only write a job row and set an
// alarm, so they return quickly. The alarm drains due jobs one at a time, which serializes work
// per conversation (and globally), and yields to a fresh invocation before it would exceed the
// per-invocation subrequest limit. Commands run at most once; failed background jobs back off (up
// to MAX_BACKOFF_MS) and retry until they succeed, so an outage of any length loses no background
// work; nothing depends on a single delivery succeeding.

import { DurableObject } from "cloudflare:workers";
import {
  type APIMessageTopLevelComponent,
  ComponentType,
  MessageFlags,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageResult,
  Routes,
} from "discord-api-types/v10";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "./budget.ts";
import { chatwootClient, toRelayConversation } from "./chatwoot/api.ts";
import { executeCommand } from "./commands/actions.ts";
import { text } from "./commands/components.ts";
import { type CommandJob, commandJobSchema } from "./commands/job.ts";
import { relaysInbox, type Settings } from "./config.ts";
import { DiscordForum } from "./discord/forum.ts";
import { DiscordHttpError, DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import { errorFields, log } from "./log.ts";
import { postQueue } from "./queue.ts";
import { queueBudget } from "./queue-limits.ts";
import { RoutingPendingError } from "./relay/notify.ts";
import { latestMessageId, type ProcessorContext, processConversation, relayFor } from "./relay/processor.ts";
import { isUnknownCard } from "./relay/relay.ts";
import { processMessageUpdate } from "./relay/updates.ts";
import { actsAutomatically, awaitsRouting, routeConversation, routesAccount } from "./routing.ts";
import { loadSettings } from "./settings.ts";
import { type Job, Store } from "./store.ts";

export const HUB_NAME = "global";

const id = z.number().int().positive();
const payloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), job: commandJobSchema }),
  z.object({ type: z.literal("sweep"), accountId: id }),
  z.object({ type: z.literal("conversation"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("message-updated"), accountId: id, conversationId: id, messageId: id }),
  z.object({ type: z.literal("route"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("queue") }),
  z.object({ type: z.literal("answer"), accountId: id, conversationId: id, answerId: z.string(), replyTo: z.string() }),
]);
type JobPayload = z.infer<typeof payloadSchema>;

const PRIORITY = {
  command: 0,
  answer: 1,
  sweep: 1,
  conversation: 2,
  route: 2,
  "message-updated": 3,
  queue: 4,
} as const;
/** How long a customer message may wait for its conversation's routing, checked this often (see services). */
const ROUTE_WAIT_MS = 30_000;
const ROUTE_POLL_MS = 1000;
/** Requests a job may need before it can start without being cut short. */
const COMMAND_BUDGET = 20;
const MIN_BUDGET = 2;
/**
 * Reading the conversation; for a decision not applied yet, whether the customer wrote since (up
 * to 3 pages); the messages; asking Jev; reading the conversation again; assigning; setting the
 * topic; a kind's reply (reading its canned response, then sending it); checking again before a
 * snooze (up to 3 pages); and the snooze (a kind that sets the status replies, if it does, and sets
 * the status instead of the assignment and what follows).
 */
const ROUTE_BUDGET = 16;
/**
 * Pages of conversations (25 each by default) a sweep job reads; a longer pass continues in the
 * next job. One, so a command waiting runs between pages rather than after the whole pass.
 */
const SWEEP_PAGES = 1;
/** Commands that change nothing in Chatwoot: their post needs no sync. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(["panel", "pick-assignee"]);
/** A job that takes longer than this is logged, to tell a slow upstream from a busy queue. */
const SLOW_JOB_MS = 5000;
/** A sweep pass left unfinished this long (e.g. its account was removed) is started over. */
const SWEEP_PASS_TTL_MS = 24 * 60 * 60 * 1000;
/** Posts without a card a sweep queues at most, and how long before one is queued again. */
const CARD_BACKFILL_PER_SWEEP = 10;
const CARD_BACKFILL_RETRY_MS = 24 * 60 * 60 * 1000;
const sweepPassSchema = z.object({ cutoff: z.number(), page: z.number().int().positive(), startedAt: z.number() });
/**
 * The longest wait between retries of a failing background job: its log turns from warnings into
 * errors after a few attempts, and it keeps retrying at this pace.
 */
const MAX_BACKOFF_MS = 30 * 60 * 1000;
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
/** How long a triage answer's draft is kept for Reply with draft, and the answer remembered. */
const ANSWER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** How long the support queue may be posted after it is due: Discord's nonce check covers a few minutes. */
const QUEUE_RETRY_MS = 3 * 60 * 1000;

export class Hub extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => this.store.migrate());
  }

  /**
   * Queues a conversation for syncing, at the earliest after `delayMs`, and, if its account is
   * routed, for routing (which does nothing once the conversation is routed).
   */
  async enqueueConversation(accountId: number, conversationId: number, delayMs = 0): Promise<void> {
    this.enqueue({ type: "conversation", accountId, conversationId }, Date.now() + delayMs);
    if (routesAccount(await loadSettings(this.env), accountId))
      this.enqueue({ type: "route", accountId, conversationId });
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

  /** Queues a command once per interaction: a repeated (replayed) request is ignored. */
  async enqueueCommand(job: CommandJob): Promise<void> {
    if (!this.store.acceptInteraction(job.interactionId)) {
      log.warn("repeated interaction ignored", { interactionId: job.interactionId });
      return;
    }
    this.enqueue({ type: "command", job });
    await this.schedule();
  }

  /** Queues a reconciliation sweep for every configured account (called by the cron trigger). */
  async requestSweep(): Promise<void> {
    for (const account of (await loadSettings(this.env)).config.accounts)
      this.enqueue({ type: "sweep", accountId: account.id });
    await this.schedule();
  }

  /** Queues the hourly support queue, if configured (called by the cron trigger at minute 0). */
  async requestQueue(): Promise<void> {
    if (!(await loadSettings(this.env)).config.queue) return;
    this.enqueue({ type: "queue" });
    await this.schedule();
  }

  /**
   * The triage bot's answer `answerId` to message `replyTo` is in the post, with the reply draft it proposes: the
   * draft is kept for Reply with draft, and the post's card offers it under the answer (Relay.answered).
   * Each answer is taken once, so a repeated call adds nothing.
   */
  async triageAnswered(threadId: string, answerId: string, replyTo: string, draft: string): Promise<void> {
    const ticket = this.store.ticketForThread(threadId);
    if (!ticket || this.store.get(answerKey(answerId)) !== undefined) return;
    this.store.set(answerKey(answerId), draft, ANSWER_TTL_MS);
    this.enqueue({ type: "answer", ...ticket, answerId, replyTo });
    await this.schedule();
  }

  /** The draft the triage bot's hook sent with an answer, while it is kept. */
  async answerDraft(answerId: string): Promise<string | null> {
    return this.store.get(answerKey(answerId)) ?? null;
  }

  async ticketForThread(threadId: string): Promise<{ accountId: number; conversationId: number } | null> {
    return this.store.ticketForThread(threadId) ?? null;
  }

  /** Cloudflare runs at most one alarm() at a time per Durable Object. */
  override async alarm(): Promise<void> {
    await this.drain();
  }

  private async drain(): Promise<void> {
    const settings = await loadSettings(this.env);
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
      if (budget.remaining < requiredBudget(payload, settings) || Date.now() - startedAt > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      const jobStarted = Date.now();
      const outcome = await this.run(job, payload, services);
      const ms = Date.now() - jobStarted;
      if (ms > SLOW_JOB_MS) log.warn("slow job", { job: job.key, ms });
      if (outcome === "yield") {
        this.store.deferJob(job);
        yielded = true;
        break;
      }
    }
    await this.schedule(yielded ? Date.now() : undefined);
  }

  private async run(job: Job, payload: JobPayload, services: ProcessorContext): Promise<"done" | "yield"> {
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
          if (Date.now() - job.createdAt > SLOW_JOB_MS) {
            log.warn("command waited", { interactionId: payload.job.interactionId, ms: Date.now() - job.createdAt });
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
        case "queue":
          // Discord drops a repeated post by its nonce only for a few minutes: however the job
          // is retried or deferred, nothing is posted after that, so the queue and its pings are
          // never posted twice (the next hour's queue lists the same tickets). The run keeps the
          // job's time, so every attempt posts the same messages with the same nonces.
          await postQueue(services, job.createdAt, job.createdAt + QUEUE_RETRY_MS);
          this.store.completeJob(job);
          return "done";
        case "answer":
          // The card moves under the answer when the conversation's post is synced next.
          services.relay.answered(payload.accountId, payload.conversationId, payload.answerId, payload.replyTo);
          this.store.completeJob(job);
          this.enqueue({ type: "conversation", accountId: payload.accountId, conversationId: payload.conversationId });
          return "done";
        case "route":
          await routeConversation(
            { ...services, fetch: services.budget.fetch },
            payload.accountId,
            payload.conversationId,
          );
          this.store.completeJob(job);
          return "done";
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) return "yield";
      if (error instanceof RoutingPendingError) {
        this.store.deferJob(job, ROUTE_POLL_MS);
        return "done";
      }
      const backoff = Math.min(5000 * 2 ** job.attempts, MAX_BACKOFF_MS);
      if (error instanceof DiscordHttpError && error.retryAfterMs !== undefined) {
        // Rate limited: wait as long as Discord asks without counting an attempt, so no rate
        // limit, however long, drops the job.
        const delay = Math.max(backoff, error.retryAfterMs);
        log.warn("job rate limited by Discord; will retry", { job: job.key, delayMs: delay });
        this.store.deferJob(job, delay);
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

  private async runCommand(job: CommandJob, services: ProcessorContext): Promise<void> {
    const { content, components, conversationGone } = await executeCommand(
      job,
      services.settings,
      services.budget.fetch,
    );
    // Chatwoot sends no webhook when a conversation is deleted: let its job close the post.
    if (conversationGone)
      this.enqueue({ type: "conversation", accountId: job.accountId, conversationId: job.conversationId });
    await respond(services.rest, job, content, components);
    if (!conversationGone && !READ_ONLY_ACTIONS.has(job.action.type)) await this.syncAfterCommand(job, services);
  }

  /**
   * Brings the post's tags and card in line right after a command, rather than with Chatwoot's
   * event for the change, whose job waits for the change's activity line (see ACTIVITY_WAIT_MS)
   * and then posts it, moving the card under it. Best effort: should this fail or run out of
   * budget, that job does it.
   */
  private async syncAfterCommand(job: CommandJob, { chatwoot, relay }: ProcessorContext): Promise<void> {
    const { accountId, conversationId } = job;
    const threadId = this.store.conversation(accountId, conversationId)?.threadId;
    if (!threadId) return;
    try {
      const conversation = await chatwoot.getConversation(accountId, conversationId);
      if (conversation) await relay.sync(accountId, toRelayConversation(conversationId, conversation), threadId);
    } catch (error) {
      log.warn("post not synced after command", { accountId, conversationId, ...errorFields(error) });
    }
  }

  /**
   * Finds conversations whose post is behind (new messages, or tags/status/archive state that
   * differ) and queues them. Covers webhooks that were never delivered and service downtime.
   * A pass reads conversations newest activity first, down to the start of its window (since the
   * previous pass started, at least `lookbackSeconds`, at most `maxCatchUpSeconds`), SWEEP_PAGES
   * pages per job, continuing where it stopped until it is done. Activity means a new message
   * (Chatwoot's `last_activity_at`); a change that creates none, such as only a custom
   * attribute, relies on its webhook. It also queues routing for open, unassigned conversations
   * of a routed account that are not routed yet, and, once a pass, posts still without a card
   * (backfillCards).
   */
  private async sweep(accountId: number, { settings, chatwoot, relay }: ProcessorContext): Promise<void> {
    const lastKey = `sweep:${accountId}:last`;
    const passKey = `sweep:${accountId}:pass`;
    const pass = this.sweepPass(passKey) ?? this.newSweepPass(lastKey, settings);

    const account = settings.account(accountId);
    let seen = 0;
    let queued = 0;
    let reachedCutoff = false;
    let page = pass.page;
    for (; page < pass.page + SWEEP_PAGES && !reachedCutoff; page += 1) {
      const conversations = await chatwoot.listConversations(accountId, page);
      if (conversations.length === 0) reachedCutoff = true;
      for (const conversation of conversations) {
        const activity = conversation.last_activity_at ?? 0;
        if (activity < pass.cutoff) {
          reachedCutoff = true;
          break;
        }
        const conversationId = conversation.id;
        if (conversationId !== undefined && awaitsRouting(settings, this.store, accountId, conversation)) {
          this.enqueue({ type: "route", accountId, conversationId });
        }
        if (conversationId === undefined || !account || !relaysInbox(account, conversation.inbox_id)) continue;
        seen += 1;
        const row = this.store.conversation(accountId, conversationId);
        const latest = latestMessageId(conversation);
        // An adopted post without a cursor needs one run to pick its starting point.
        const needsCursor = row?.threadId !== undefined && row.cursor === undefined;
        const cursor = row?.cursor ?? settings.config.relay.startAfterMessageId;
        const behind = needsCursor || (latest !== undefined && latest > cursor);
        // A card still to be moved or posted counts too (its sync may have failed).
        const stale =
          row?.threadId !== undefined &&
          (row.state !== relay.stateOf(toRelayConversation(conversationId, conversation)) ||
            row.cardCovered === 1 ||
            isUnknownCard(row.cardId));
        if (behind || stale) {
          this.enqueue({ type: "conversation", accountId, conversationId });
          queued += 1;
        }
      }
    }
    if (pass.page === 1) queued += this.backfillCards(accountId);
    if (reachedCutoff) {
      // The next pass covers everything active since this one started, so activity while it ran
      // (which reorders the list) is read again.
      this.store.set(lastKey, String(pass.startedAt));
      this.store.delete(passKey);
      log.info("sweep done", { accountId, pages: page - 1, seen, queued });
    } else {
      this.store.set(passKey, JSON.stringify({ ...pass, page }), SWEEP_PASS_TTL_MS);
      this.enqueue({ type: "sweep", accountId }); // Continues in the next job.
      log.info("sweep continues", { accountId, nextPage: page, seen, queued });
    }
  }

  /**
   * Queues a few of the account's posts without a card (from before cards) whose ticket is not
   * resolved, however long ago their last activity, each at most once a day. Returns how many.
   */
  private backfillCards(accountId: number): number {
    const ids = this.store.takePostsWithoutCard(accountId, CARD_BACKFILL_PER_SWEEP, CARD_BACKFILL_RETRY_MS);
    for (const conversationId of ids) this.enqueue({ type: "conversation", accountId, conversationId });
    return ids.length;
  }

  private sweepPass(key: string): z.infer<typeof sweepPassSchema> | undefined {
    const stored = this.store.get(key);
    if (stored === undefined) return undefined;
    try {
      const parsed = sweepPassSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private newSweepPass(lastKey: string, settings: Settings): z.infer<typeof sweepPassSchema> {
    const last = Number(this.store.get(lastKey) ?? 0);
    const now = Date.now();
    const { lookbackSeconds, maxCatchUpSeconds } = settings.config.reconcile;
    const sinceLast = last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds;
    const window = Math.min(Math.max(sinceLast, lookbackSeconds), maxCatchUpSeconds);
    return { cutoff: now / 1000 - window, page: 1, startedAt: now };
  }

  private services(settings: Settings, budget: Budget): ProcessorContext {
    const rest = new DiscordRest(settings.secrets.DISCORD_BOT_TOKEN, budget.fetch);
    const chatwoot = chatwootClient(
      settings.config.chatwoot.baseUrl,
      settings.secrets.CHATWOOT_RELAY_TOKEN,
      budget.fetch,
    );
    const forum = new DiscordForum(rest, this.store);
    // A customer message waits for its conversation's routing, whose kind may handle it, replying or
    // setting the ticket aside (then the triage bot is not called): while the route job is queued and
    // has not failed, up to ROUTE_WAIT_MS after it was queued.
    const relay = relayFor(settings, forum, this.store, (accountId, conversationId) => {
      if (!actsAutomatically(settings, accountId)) return false;
      const age = this.store.pendingJobAge(jobKey({ type: "route", accountId, conversationId }));
      return age !== undefined && age < ROUTE_WAIT_MS;
    });
    return { settings, store: this.store, relay, forum, chatwoot, budget, rest };
  }

  private enqueue(payload: JobPayload, notBefore?: number): void {
    this.store.enqueue(jobKey(payload), PRIORITY[payload.type], JSON.stringify(payload), notBefore);
  }

  /** Sets the alarm for the earliest due job (or `at`), unless an earlier alarm is already set. */
  private async schedule(at?: number): Promise<void> {
    const next = at ?? this.store.nextWakeup();
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

/**
 * Replaces the invoker's "thinking…" with `content`, and `components`: menus under the content,
 * or, when they include more than action rows, a Components V2 message (the Manage panel, the one
 * the job came from or a new one), which has no content.
 */
async function respond(
  rest: DiscordRest,
  job: CommandJob,
  content: string,
  given?: APIMessageTopLevelComponent[],
): Promise<void> {
  // A job from the Manage panel replaces that Components V2 message, which cannot take content.
  const components = given ?? (job.panel ? [text(content)] : undefined);
  const v2 = components?.some((component) => component.type !== ComponentType.ActionRow);
  const body = v2
    ? { flags: MessageFlags.IsComponentsV2, components }
    : { content, ...(components ? { components } : {}) };
  try {
    await rest.patch<RESTPatchAPIWebhookWithTokenMessageResult, RESTPatchAPIWebhookWithTokenMessageJSONBody>(
      Routes.webhookMessage(job.applicationId, job.token, "@original"),
      { body: { ...body, allowed_mentions: { parse: [] } }, auth: false },
    );
  } catch (error) {
    log.error("command follow-up failed", { interactionId: job.interactionId, ...errorFields(error) });
  }
}

/** One job per key: a job queued again while it waits is not queued twice. */
function jobKey(payload: JobPayload): string {
  switch (payload.type) {
    case "command":
      return `command:${payload.job.interactionId}`;
    case "sweep":
      return `sweep:${payload.accountId}`;
    case "queue":
      return "queue";
    case "conversation":
    case "route":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}`;
    case "answer":
      return answerKey(payload.answerId);
    case "message-updated":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}:${payload.messageId}`;
  }
}

function requiredBudget(payload: JobPayload, settings: Settings): number {
  if (payload.type === "command") return COMMAND_BUDGET;
  if (payload.type === "queue") return queueBudget(settings.config.accounts.length);
  if (payload.type === "route") return ROUTE_BUDGET;
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

function answerKey(answerId: string): string {
  return `answer:${answerId}`;
}
