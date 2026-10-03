import { DurableObject } from "cloudflare:workers";
import {
  type APIInteraction,
  type APIMessageTopLevelComponent,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type RESTGetAPIChannelResult,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageResult,
  Routes,
} from "discord-api-types/v10";
import { z } from "zod";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import {
  Budget,
  BudgetExhaustedError,
  JobDeadlineError,
  METADATA_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
} from "../../../shared/budget.ts";
import { ChatwootError, chatwootClient, toRelayConversation } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { retryDelay } from "../../../shared/store.ts";
import { cleanLegacyCards } from "./adoption.ts";
import { type CommandExecution, commandPanel, commandStarted, executeCommand } from "./commands/actions.ts";
import { downloadAttachment } from "./commands/attachments.ts";
import { text } from "./commands/components.ts";
import { type HandlerResult, handleInteraction } from "./commands/handler.ts";
import { type CommandJob, commandJobSchema } from "./commands/job.ts";
import type { Settings } from "./config.ts";
import { control, type ThreadOwner } from "./control.ts";
import { DiscordForum } from "./discord/forum.ts";
import { DiscordLimiter } from "./discord/limiter.ts";
import { DiscordHttpError, DiscordRest } from "./discord/rest.ts";
import { Effects } from "./effects.ts";
import type { Env } from "./env.ts";
import { type ProcessorContext, processConversation, refreshMetadata, relayFor } from "./relay/processor.ts";
import { processMessageUpdate } from "./relay/updates.ts";
import { loadSettings } from "./settings.ts";
import { type Job, Store } from "./store.ts";

const id = z.number().int().positive();
const resultSchema = z.object({
  content: z.string(),
  conversationGone: z.boolean(),
  confirmed: z.boolean().optional(),
  components: z
    .array(
      z.custom<APIMessageTopLevelComponent>((value) => typeof value === "object" && value !== null && "type" in value),
    )
    .optional(),
});
const payloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), job: commandJobSchema }),
  z.object({ type: z.literal("feedback"), job: commandJobSchema, result: resultSchema, expiresAt: z.number() }),
  z.object({ type: z.literal("sync"), accountId: id, conversationId: id }),
  z.object({
    type: z.literal("metadata"),
    accountId: id,
    inboxId: id.optional(),
    discordUserId: z.string().optional(),
  }),
  z.object({ type: z.literal("conversation"), accountId: id, conversationId: id, activity: z.boolean().optional() }),
  z.object({ type: z.literal("message-updated"), accountId: id, conversationId: id, messageId: id }),
  z.object({ type: z.literal("answer"), accountId: id, conversationId: id, answerId: z.string(), replyTo: z.string() }),
]);
type JobPayload = z.infer<typeof payloadSchema>;

const PRIORITY = {
  command: 1,
  answer: 2,
  feedback: 0,
  sync: 2,
  conversation: 2,
  "message-updated": 2,
  metadata: 5,
} as const;
/** Commands that change nothing in Chatwoot: their post needs no sync. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(["panel", "pick-assignee"]);
/** A job that takes longer than this is logged, to tell a slow upstream from a busy queue. */
const SLOW_JOB_MS = 5000;
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

export class Conversation extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql, Date.now, (write) => ctx.storage.transactionSync(write));
    this.store.migrate();
  }

  stage(
    owner: ThreadOwner,
    threadId: string,
    epoch: string,
    watermark: number,
    responses: Array<{ messageId: number; digest: string }>,
  ): void {
    this.bind(owner.accountId, owner.conversationId);
    const existing = this.store.get("adoption:stage");
    const stage = JSON.stringify({
      owner: {
        accountId: owner.accountId,
        conversationId: owner.conversationId,
        guildId: owner.guildId,
        forumId: owner.forumId,
        generation: owner.generation,
      },
      threadId,
      epoch,
      watermark,
      responses: responses
        .map(({ messageId, digest }) => ({ messageId, digest }))
        .sort((a, b) => a.messageId - b.messageId),
    });
    if (existing && existing !== stage) throw new Error("Adoption stage conflict");
    if (existing === stage) return;
    if (this.store.conversation(owner.accountId, owner.conversationId)?.threadId)
      throw new Error("Adoption target already active");
    this.ctx.storage.transactionSync(() => {
      this.store.set("adoption:stage", stage);
      this.store.set("generation", String(owner.generation));
      for (const response of responses) {
        this.store.savePostedResponse(owner.accountId, owner.conversationId, response.messageId, response.digest);
        this.store.set(
          `observed:${owner.accountId}:${owner.conversationId}:derived:${response.messageId}`,
          JSON.stringify({ value: response.digest, revision: 0 }),
        );
      }
    });
  }

  /**
   * Queues a conversation for syncing, at the earliest after `delayMs`.
   */
  async enqueueConversation(accountId: number, conversationId: number, delayMs = 0): Promise<void> {
    this.bind(accountId, conversationId);
    if (delayMs > 0 && this.store.get("held")) {
      this.enqueue({ type: "conversation", accountId, conversationId });
      this.enqueue({ type: "conversation", accountId, conversationId, activity: true }, Date.now() + delayMs);
    } else this.enqueue({ type: "conversation", accountId, conversationId }, Date.now() + delayMs);
    if (delayMs > 0) this.enqueue({ type: "sync", accountId, conversationId });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  /**
   * Queues a check of a message reported as deleted (its Discord messages are removed), as
   * answered by the customer (the response is posted), or with a changed outgoing delivery status.
   */
  async enqueueMessageUpdate(accountId: number, conversationId: number, messageId: number): Promise<void> {
    this.bind(accountId, conversationId);
    // Do this on receipt: the conversation job runs before the message-update job.
    if (this.store.invalidateAnswerScans(accountId, conversationId)) {
      this.enqueue({ type: "conversation", accountId, conversationId });
    }
    this.enqueue({ type: "message-updated", accountId, conversationId, messageId });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  async interaction(interaction: APIInteraction, owner: ThreadOwner): Promise<HandlerResult["response"]> {
    this.bind(owner.accountId, owner.conversationId);
    const threadId = interaction.channel?.id ?? interaction.channel_id;
    const row = this.store.conversation(owner.accountId, owner.conversationId);
    if (row?.threadId && (row.threadId !== threadId || Number(this.store.get("generation") ?? 1) !== owner.generation))
      throw new Error("Stale thread generation");
    const saved = this.store.get(`admission:${interaction.id}`);
    if (saved) return JSON.parse(saved);
    const settings = await loadSettings(this.env);
    if (settings.config.cutover && !row?.threadId && !this.store.get("adoption:stage"))
      throw new Error("Thread adoption is not staged");
    const modalBoundary = JSON.stringify({
      generation: owner.generation,
      epoch: settings.config.cutover?.epoch ?? "initial",
      customer: this.store.get(`customer:${owner.accountId}:${owner.conversationId}`) ?? "",
    });
    if (
      interaction.type === InteractionType.ModalSubmit &&
      this.store.get(`modal:${interaction.data.custom_id}`) !== modalBoundary
    ) {
      return {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { flags: MessageFlags.Ephemeral, content: "This editor is no longer current. Please reopen it." },
      };
    }
    const result = await handleInteraction(interaction, {
      settings,
      ticketForThread: async () => ({ accountId: owner.accountId, conversationId: owner.conversationId }),
      draftOf: async (_threadId, answerId) => {
        const row = this.store.conversation(owner.accountId, owner.conversationId);
        const draft =
          row?.answerId === answerId && row.customerMessageId && row.answerSourceId === row.customerMessageId
            ? this.store.get(answerKey(answerId))
            : undefined;
        return draft === undefined ? { missing: "unreadable" as const } : { text: draft };
      },
    });
    this.ctx.storage.transactionSync(() => {
      if (result.response.type === InteractionResponseType.Modal)
        this.store.set(`modal:${result.response.data.custom_id}`, modalBoundary, 15 * 60 * 1000);
      if (result.job && this.store.acceptInteraction(result.job.interactionId))
        this.enqueue({ type: "command", job: result.job });
      this.store.set(`admission:${interaction.id}`, JSON.stringify(result.response), 60 * 60 * 1000);
    });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
    return result.response;
  }

  /** Queues a command once per interaction: a repeated (replayed) request is ignored. */
  async enqueueCommand(job: CommandJob): Promise<void> {
    this.bind(job.accountId, job.conversationId);
    if (!this.store.acceptInteraction(job.interactionId)) {
      log.warn("repeated interaction ignored", { interactionId: job.interactionId });
      return;
    }
    this.enqueue({ type: "command", job });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  /**
   * The triage bot's answer `answerId` to message `replyTo` is in the post, with the reply draft it proposes: the
   * draft is kept for Reply with draft, and the post's card offers it under the answer (Relay.answered).
   * Each answer is taken once, so a repeated call adds nothing.
   */
  async triageAnswered(threadId: string, answerId: string, replyTo: string, draft: string): Promise<void> {
    const ticket = this.store.ticketForThread(threadId);
    if (!ticket || this.store.get(answerKey(answerId)) !== undefined) return;
    const row = this.store.conversation(ticket.accountId, ticket.conversationId);
    if (
      !row?.customerMessageId ||
      this.store.firstPart(ticket.accountId, ticket.conversationId, replyTo) !== row.customerMessageId
    )
      return;
    this.store.set(answerKey(answerId), draft, ANSWER_TTL_MS);
    this.enqueue({ type: "answer", ...ticket, answerId, replyTo });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  /** Cloudflare runs at most one alarm() at a time per Durable Object. */
  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    if (settings.config.cutover?.phase === "maintenance") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const budget = new Budget(settings.config.relay.subrequestBudget);
    const services = this.services(settings, budget);
    const startedAt = Date.now();
    let yielded = false;

    this.store.prune();
    this.store.wakeHeldJobs();
    for (let job = this.store.nextDueJob(); job; job = this.store.nextDueJob()) {
      const parsed = payloadSchema.safeParse(parseJson(job.payload));
      if (!parsed.success) {
        log.warn("unreadable job dropped", { job: job.key });
        this.store.deleteJob(job.key);
        continue;
      }
      const payload = parsed.data;
      if (budget.remaining < 8 || Date.now() - startedAt > 10_000) {
        yielded = true;
        break;
      }
      budget.startSlice();
      const jobStarted = Date.now();
      const outcome = await this.run(job, payload, services);
      await this.flushDirectory(budget);
      const ms = Date.now() - jobStarted;
      if (ms > SLOW_JOB_MS) log.warn("slow job", { job: job.key, ms });
      if (outcome === "yield") {
        this.store.deferJob(job);
        yielded = true;
        break;
      }
    }
    await scheduleAlarm(this.ctx, yielded ? Date.now() : this.store.nextWakeup());
  }

  private async run(job: Job, payload: JobPayload, services: ProcessorContext): Promise<"done" | "yield"> {
    try {
      await this.flushDirectory(services.budget);
      if (!this.store.get("registered")) {
        const [accountId, conversationId] = (this.store.get("owner") ?? "").split(":").map(Number);
        if (!accountId || !conversationId) throw new Error("Missing conversation identity");
        await control(services.budget, () =>
          this.env.ACCOUNT_SWEEP.getByName(`account:v1:${accountId}`).register(accountId, conversationId),
        );
        this.store.set("registered", "1");
      }
      const cutover = services.settings.config.cutover;
      const staged = this.store.get("adoption:stage");
      if (
        (cutover || staged) &&
        payload.type !== "command" &&
        payload.type !== "feedback" &&
        !this.store.get("adoption:complete")
      ) {
        if (staged) {
          if (!cutover || cutover.phase !== "active")
            throw new Error("Unfinished adoption requires matching active cutover");
          const stage: { owner: ThreadOwner; threadId: string; epoch: string; watermark: number } = JSON.parse(staged);
          if (stage.epoch !== cutover.epoch || stage.watermark !== services.settings.config.relay.startAfterMessageId)
            throw new Error("Cutover epoch or watermark mismatch");
          const raw = await services.chatwoot.getConversation(stage.owner.accountId, stage.owner.conversationId);
          const link = `https://discord.com/channels/${stage.owner.guildId}/${stage.threadId}`;
          if (raw?.custom_attributes?.[services.settings.config.relay.linkAttribute] !== link)
            throw new Error("Verified adoption link changed");
          await this.claimThread(
            stage.owner.accountId,
            stage.owner.conversationId,
            stage.threadId,
            services.rest,
            services.budget,
            services.settings,
          );
          const webhookIds = cutover.legacyWebhooks[stage.owner.forumId];
          if (!webhookIds?.length) throw new Error("Old webhook ownership not verified");
          if (!(await cleanLegacyCards(this.store, services.rest, services.budget, stage.threadId, webhookIds)))
            return "yield";
          this.ctx.storage.transactionSync(() => {
            this.store.adoptThread(stage.owner.accountId, stage.owner.conversationId, stage.threadId);
            this.store.setCursor(stage.owner.accountId, stage.owner.conversationId, stage.watermark);
            this.store.set("adoption:complete", "1");
            this.enqueue({
              type: "sync",
              accountId: stage.owner.accountId,
              conversationId: stage.owner.conversationId,
            });
          });
        } else {
          const [accountId, conversationId] = (this.store.get("owner") ?? "").split(":").map(Number);
          const raw = await services.chatwoot.getConversation(accountId ?? 0, conversationId ?? 0);
          if (raw?.custom_attributes?.[services.settings.config.relay.linkAttribute])
            throw new Error("Existing thread was not staged for adoption");
          this.store.set("adoption:complete", "new");
        }
      }
      switch (payload.type) {
        case "command": {
          const saved = resultSchema.safeParse(
            parseJson(this.store.get(`command:${payload.job.interactionId}:result`)),
          );
          const result = saved.success
            ? saved.data
            : Date.now() - job.createdAt > COMMAND_START_DEADLINE_MS &&
                !commandStarted(new Effects(this.store), payload.job.interactionId)
              ? { content: EXPIRED, conversationGone: false }
              : await this.runCommand(payload.job, services);
          this.store.set(`command:${payload.job.interactionId}:result`, JSON.stringify(result), 60 * 60 * 1000);
          this.enqueue({ type: "feedback", job: payload.job, result, expiresAt: job.createdAt + 15 * 60 * 1000 });
          if (result.conversationGone)
            this.enqueue({
              type: "conversation",
              accountId: payload.job.accountId,
              conversationId: payload.job.conversationId,
            });
          else if (result.content !== EXPIRED && !READ_ONLY_ACTIONS.has(payload.job.action.type))
            this.enqueue({
              type: "sync",
              accountId: payload.job.accountId,
              conversationId: payload.job.conversationId,
            });
          this.store.clearCommandFiles(payload.job.interactionId);
          this.store.completeJob(job);
          return "done";
        }
        case "feedback": {
          if (Date.now() < payload.expiresAt) {
            await respond(services.rest, payload.job, payload.result.content, payload.result.components);
            if (payload.result.confirmed === true && !payload.result.components) {
              try {
                const components = await commandPanel(
                  payload.job,
                  payload.result,
                  services.settings,
                  services.budget.fetch,
                  this.store,
                );
                if (components) await respond(services.rest, payload.job, payload.result.content, components);
              } catch (error) {
                log.warn("optional command panel failed", {
                  interactionId: payload.job.interactionId,
                  ...errorFields(error),
                });
              }
            }
          }
          this.store.completeJob(job);
          return "done";
        }
        case "sync":
          await this.syncAfterCommand(payload, services);
          this.store.completeJob(job);
          return "done";
        case "metadata":
          await refreshMetadata(services, payload);
          this.store.completeJob(job);
          return "done";
        case "conversation": {
          const outcome = await processConversation(services, payload.accountId, payload.conversationId);
          if (outcome === "pending") {
            this.store.set("held", "1");
            if (this.store.conversation(payload.accountId, payload.conversationId)?.cardCovered === 1)
              this.enqueue({ type: "sync", accountId: payload.accountId, conversationId: payload.conversationId });
            this.store.deferJob(job, 5 * 60 * 1000);
            return "done";
          }
          if (outcome === "done") {
            this.store.delete("held");
            this.store.completeJob(job);
          }
          return outcome;
        }
        case "message-updated":
          await processMessageUpdate(services, payload.accountId, payload.conversationId, payload.messageId);
          this.store.completeJob(job);
          return "done";
        case "answer":
          // The card moves under the answer when the conversation's post is synced next.
          services.relay.answered(payload.accountId, payload.conversationId, payload.answerId, payload.replyTo);
          this.store.completeJob(job);
          this.enqueue({ type: "conversation", accountId: payload.accountId, conversationId: payload.conversationId });
          return "done";
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError || error instanceof JobDeadlineError) return "yield";
      const backoff = retryDelay(job.attempts);
      if ((error instanceof DiscordHttpError || error instanceof ChatwootError) && error.retryAfterMs !== undefined) {
        // Rate limited: wait as long as Discord asks without counting an attempt, so no rate
        // limit, however long, drops the job.
        const delay = error.retryAfterMs;
        log.warn("job rate limited; will retry", { job: job.key, delayMs: delay });
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

  private async runCommand(job: CommandJob, services: ProcessorContext) {
    const fetch = services.budget.fetchWith(METADATA_TIMEOUT_MS);
    const execution: CommandExecution = {
      settings: services.settings,
      fetch,
      limits: this.store,
      effects: new Effects(this.store),
      uploadFetch: services.budget.fetchWith(TRANSFER_TIMEOUT_MS),
      attachment: async (action, index) => {
        const file = action.files[index];
        if (!file) throw new Error("Missing command attachment");
        services.budget.checkpoint();
        const cached = this.store.commandFile(job.interactionId, index, file.contentType || "application/octet-stream");
        if (cached) return { blob: cached, filename: file.filename || "attachment" };
        const downloaded = await downloadAttachment(
          file,
          services.settings.config.attachments.maxFileBytes,
          services.budget.fetchWith(TRANSFER_TIMEOUT_MS),
        );
        await this.store.saveCommandFile(job.interactionId, index, downloaded.blob);
        return downloaded;
      },
    };
    return executeCommand(job, execution);
  }

  private async syncAfterCommand(
    job: { accountId: number; conversationId: number },
    { chatwoot, relay }: ProcessorContext,
  ): Promise<void> {
    const { accountId, conversationId } = job;
    const threadId = this.store.conversation(accountId, conversationId)?.threadId;
    if (!threadId) return;
    const conversation = await chatwoot.getConversation(accountId, conversationId);
    if (conversation) await relay.sync(accountId, toRelayConversation(conversationId, conversation), threadId);
  }

  private services(settings: Settings, budget: Budget): ProcessorContext {
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
    const forum = new DiscordForum(rest, this.store, {
      lookup: (forumId) =>
        control(budget, () => this.env.FORUM_REGISTRY.getByName(`forum:v1:${forumId}`).lookup(forumId)),
      invalidate: (forumId, version) =>
        control(budget, () => this.env.FORUM_REGISTRY.getByName(`forum:v1:${forumId}`).invalidate(forumId, version)),
    });
    const relay = relayFor(settings, forum, this.store, {
      reserveTriage: (hour, key, limit) => {
        if (Date.now() < (settings.config.cutover?.notificationsAfter ?? 0)) return Promise.resolve(false);
        return control(budget, () =>
          this.env.TRIAGE_BUDGET.getByName(`triage:installation:${hour}`).reserve(hour, key, limit),
        );
      },
      ensureThread: (accountId, conversationId, threadId) =>
        this.claimThread(accountId, conversationId, threadId, rest, budget, settings),
    });
    return {
      settings,
      store: this.store,
      relay,
      forum,
      chatwoot,
      budget,
      rest,
      enqueueMetadata: (accountId, inboxId, discordUserId) =>
        this.enqueue({
          type: "metadata",
          accountId,
          ...(inboxId ? { inboxId } : {}),
          ...(discordUserId ? { discordUserId } : {}),
        }),
    };
  }

  private async flushDirectory(budget: Budget): Promise<void> {
    const pending = this.store.get("directory:tombstone");
    if (!pending) return;
    const saved: { threadId: string; owner: ThreadOwner | null } = JSON.parse(pending);
    const owner = saved.owner;
    if (owner)
      await control(budget, () => this.env.THREAD_DIRECTORY.getByName(`thread:v1:${saved.threadId}`).tombstone(owner));
    this.store.delete("directory:tombstone");
  }

  private async claimThread(
    accountId: number,
    conversationId: number,
    threadId: string,
    rest: DiscordRest,
    budget: Budget,
    settings: Settings,
  ): Promise<void> {
    if (this.store.get("directory:thread") === threadId) return;
    const channel = await rest.get<RESTGetAPIChannelResult>(Routes.channel(threadId));
    const forumId = settings.account(accountId)?.forumChannelId;
    if (
      !forumId ||
      !("parent_id" in channel) ||
      channel.parent_id !== forumId ||
      !("guild_id" in channel) ||
      !channel.guild_id
    )
      throw new Error("Thread scope mismatch");
    const generation = Number(this.store.get("generation") ?? 1);
    const owner = { accountId, conversationId, forumId, guildId: channel.guild_id, generation };
    if (!(await control(budget, () => this.env.THREAD_DIRECTORY.getByName(`thread:v1:${threadId}`).claim(owner))))
      throw new Error("Thread ownership conflict");
    this.store.set("directory:thread", threadId);
    this.store.set("directory:owner", JSON.stringify(owner));
  }

  private bind(accountId: number, conversationId: number): void {
    const owner = `${accountId}:${conversationId}`;
    const existing = this.store.get("owner");
    if (existing !== undefined && existing !== owner) throw new Error("Conversation owner mismatch");
    this.store.set("owner", owner);
  }

  private enqueue(payload: JobPayload, notBefore?: number): void {
    this.store.enqueue(jobKey(payload), PRIORITY[payload.type], JSON.stringify(payload), notBefore);
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
  await rest.patch<RESTPatchAPIWebhookWithTokenMessageResult, RESTPatchAPIWebhookWithTokenMessageJSONBody>(
    Routes.webhookMessage(job.applicationId, job.token, "@original"),
    { body: { ...body, allowed_mentions: { parse: [] } }, auth: false, interaction: true },
  );
}

/** One job per key: a job queued again while it waits is not queued twice. */
function jobKey(payload: JobPayload): string {
  switch (payload.type) {
    case "command":
    case "feedback":
      return `${payload.type}:${payload.job.interactionId}`;
    case "metadata":
      return `metadata:${payload.accountId}:${payload.inboxId ?? ""}:${payload.discordUserId ?? ""}`;
    case "conversation":
      return `${payload.activity ? "activity" : "conversation"}:${payload.accountId}:${payload.conversationId}`;
    case "sync":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}`;
    case "answer":
      return answerKey(payload.answerId);
    case "message-updated":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}:${payload.messageId}`;
  }
}

function answerKey(answerId: string): string {
  return `answer:${answerId}`;
}
