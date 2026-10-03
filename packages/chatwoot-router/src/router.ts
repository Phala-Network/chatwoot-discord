import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { ChatwootError, chatwootClient } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore, retryDelay } from "../../../shared/store.ts";
import type { Env } from "./env.ts";
import { routeConversation, routesAccount } from "./routing.ts";
import { loadSettings } from "./settings.ts";
import { clearFailures, expectActivity, recordFailure } from "./turn.ts";
import type { Transition } from "./webhook.ts";

export const ROUTER_NAME = "global";
export const ROUTE_BUDGET = 45;
const BUDGET = { route: ROUTE_BUDGET, sweep: 1 };
const RUN_WALL_MS = 5 * 60 * 1000;
const id = z.number().int().positive();
const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("sweep"), accountId: id }),
]);
type Payload = z.infer<typeof jobSchema>;

export class Router extends DurableObject<Env> {
  private readonly store: QueueStore;

  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    this.store = new QueueStore(context.storage.sql);
    this.store.migrate();
  }

  async enqueueConversation(accountId: number, conversationId: number, transition?: Transition): Promise<void> {
    const settings = await loadSettings(this.env);
    if (!routesAccount(settings, accountId)) return;
    if (transition) expectActivity(this.store, accountId, conversationId, transition);
    this.enqueue({ type: "route", accountId, conversationId });
    await this.schedule();
  }

  async requestSweep(): Promise<void> {
    for (const accountId of Object.keys((await loadSettings(this.env)).config.routing.accounts)) {
      this.enqueue({ type: "sweep", accountId: Number(accountId) });
    }
    await this.schedule();
  }

  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.subrequestBudget);
    const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, settings.secrets.CHATWOOT_TOKEN, budget.fetch);
    const started = Date.now();
    let yielded = false;
    this.store.prune();
    for (let job = this.store.nextDueJob(); job; job = this.store.nextDueJob()) {
      const parsed = jobSchema.safeParse(parseJson(job.payload));
      if (!parsed.success) {
        log.warn("unreadable job dropped", { job: job.key });
        this.store.deleteJob(job.key);
        continue;
      }
      const payload = parsed.data;
      if (budget.remaining < BUDGET[payload.type] || Date.now() - started > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      try {
        const ctx = { settings, chatwoot, store: this.store, fetch: budget.fetch };
        if (payload.type === "route") {
          if ((await routeConversation(ctx, payload.accountId, payload.conversationId)) === "defer") {
            this.store.deferJob(job);
            yielded = true;
            break;
          }
          clearFailures(this.store, payload.accountId, payload.conversationId);
        } else if (routesAccount(settings, payload.accountId)) {
          await this.sweep(chatwoot, payload.accountId, settings.config.routing.botIds[String(payload.accountId)]);
        }
        this.store.completeJob(job);
      } catch (error) {
        if (error instanceof ChatwootError && error.conversationMissing) {
          log.info("conversation deleted; job dropped", { job: job.key });
          this.store.deleteJob(job.key);
          continue;
        }
        if (error instanceof BudgetExhaustedError) {
          this.store.deferJob(job);
          yielded = true;
          break;
        }
        const attempts =
          payload.type === "route"
            ? recordFailure(this.store, payload.accountId, payload.conversationId)
            : job.attempts + 1;
        const delay = retryDelay(attempts - 1);
        const logAt = attempts >= 3 ? log.error : log.warn;
        logAt("job failed; will retry", {
          job: job.key,
          attempts,
          delayMs: delay,
          ...errorFields(error),
        });
        this.store.retryJob(job, delay);
      }
    }
    await this.schedule(yielded ? Date.now() : undefined);
  }

  private async sweep(
    chatwoot: ReturnType<typeof chatwootClient>,
    accountId: number,
    botId: number | undefined,
  ): Promise<void> {
    const key = `sweep:${accountId}:all`;
    const saved = id.safeParse(parseJson(this.store.get(key)));
    const page = saved.success ? saved.data : 1;
    // Route snapshots decide ownership from live state, including disconnected bot leftovers.
    const conversations = await chatwoot.listConversations(accountId, page);
    for (const conversation of conversations) {
      if (
        conversation.id !== undefined &&
        (conversation.status === "pending" ||
          (conversation.meta?.assignee_type === "AgentBot" && conversation.meta.assignee?.id === botId))
      )
        this.enqueue({ type: "route", accountId, conversationId: conversation.id });
    }
    if (conversations.length === 0) {
      this.store.delete(key);
      return;
    }
    this.store.set(key, String(page + 1));
    this.enqueue({ type: "sweep", accountId });
  }

  private enqueue(payload: Payload): void {
    const key =
      payload.type === "sweep"
        ? `sweep:${payload.accountId}`
        : `${payload.type}:${payload.accountId}:${payload.conversationId}`;
    this.store.enqueue(key, payload.type === "sweep" ? 1 : 0, JSON.stringify(payload));
  }

  private async schedule(at?: number): Promise<void> {
    const next = at ?? this.store.nextWakeup();
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}
