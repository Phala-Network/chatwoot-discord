import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { ChatwootError, chatwootClient } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore, retryDelay } from "../../../shared/store.ts";
import { readSweepPass, saveSweepPass } from "../../../shared/sweep.ts";
import { needsCompletionRepair, writeCompletion } from "./completion.ts";
import type { Settings } from "./config.ts";
import type { Env } from "./env.ts";
import { routeConversation, routesAccount } from "./routing.ts";
import { loadSettings } from "./settings.ts";

export const ROUTER_NAME = "global";
export const ROUTE_BUDGET = 19;
const BUDGET = { route: ROUTE_BUDGET, repair: 2, sweep: 1 };
const RUN_WALL_MS = 5 * 60 * 1000;
const id = z.number().int().positive();
const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("repair"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("sweep"), accountId: id }),
]);
type Payload = z.infer<typeof jobSchema>;

export class Router extends DurableObject<Env> {
  private readonly store: QueueStore;

  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    this.store = new QueueStore(context.storage.sql);
    context.blockConcurrencyWhile(async () => this.store.migrate());
  }

  async enqueueConversation(accountId: number, conversationId: number, messageId?: number): Promise<void> {
    const settings = await loadSettings(this.env);
    if (!routesAccount(settings, accountId)) return;
    if (messageId !== undefined) {
      const key = customerKey(accountId, conversationId);
      this.store.set(key, String(Math.max(Number(this.store.get(key) ?? 0), messageId)));
    }
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
          const result = await routeConversation(
            ctx,
            payload.accountId,
            payload.conversationId,
            Number(this.store.get(customerKey(payload.accountId, payload.conversationId)) ?? 0),
          );
          if (result === "defer") {
            this.store.deferJob(job);
            yielded = true;
            break;
          }
        } else if (routesAccount(settings, payload.accountId)) {
          if (payload.type === "repair") await writeCompletion(ctx, payload.accountId, payload.conversationId);
          else await this.sweep(settings, chatwoot, payload.accountId);
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
        const delay = retryDelay(job.attempts);
        const logAt = job.attempts + 1 >= 3 ? log.error : log.warn;
        logAt("job failed; will retry", {
          job: job.key,
          attempts: job.attempts + 1,
          delayMs: delay,
          ...errorFields(error),
        });
        this.store.retryJob(job, delay);
      }
    }
    await this.schedule(yielded ? Date.now() : undefined);
  }

  private async sweep(
    settings: Settings,
    chatwoot: ReturnType<typeof chatwootClient>,
    accountId: number,
  ): Promise<void> {
    const pass = readSweepPass(this.store, accountId, settings.config.reconcile);
    const conversations = await chatwoot.listConversations(accountId, pass.page);
    let finished = conversations.length === 0;
    for (const conversation of conversations) {
      if ((conversation.last_activity_at ?? 0) < pass.cutoff) {
        finished = true;
        break;
      }
      const conversationId = conversation.id;
      if (conversationId === undefined) continue;
      if (conversation.status === "open" && !conversation.meta?.assignee) {
        this.enqueue({ type: "route", accountId, conversationId });
      }
      if (needsCompletionRepair({ store: this.store }, accountId, conversation)) {
        this.enqueue({ type: "repair", accountId, conversationId });
      }
    }
    if (finished) {
      saveSweepPass(this.store, accountId, pass);
    } else {
      saveSweepPass(this.store, accountId, pass, pass.page + 1);
      this.enqueue({ type: "sweep", accountId });
    }
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

function customerKey(accountId: number, conversationId: number): string {
  return `customer:${accountId}:${conversationId}`;
}
