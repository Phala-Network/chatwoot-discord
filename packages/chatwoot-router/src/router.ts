import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { ChatwootError, chatwootClient } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore, retryDelay } from "../../../shared/store.ts";
import type { Settings } from "./config.ts";
import type { Env } from "./env.ts";
import { routeConversation, routesAccount } from "./routing.ts";
import { loadSettings } from "./settings.ts";
import { expectActivity, requestHandoff } from "./turn.ts";
import type { Transition } from "./webhook.ts";

export const ROUTER_NAME = "global";
export const ROUTE_BUDGET = 45;
const BUDGET = { route: ROUTE_BUDGET, sweep: 2 };
const RUN_WALL_MS = 5 * 60 * 1000;
const id = z.number().int().positive();
const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("sweep"), accountId: id }),
]);
type Payload = z.infer<typeof jobSchema>;
const passSchema = z.object({
  page: z.number().int().positive(),
  remaining: z.array(id),
  routed: z.array(id),
});

export class Router extends DurableObject<Env> {
  private readonly store: QueueStore;

  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    this.store = new QueueStore(context.storage.sql);
    context.blockConcurrencyWhile(async () => {
      this.store.migrate();
      if (!this.store.get("migration:agent-bot")) {
        // Old account-webhook jobs and effects cannot run against the new lifecycle. Reply
        // attempts survive; Chatwoot attributes remain untouched throughout rollback.
        context.storage.sql.exec("DELETE FROM jobs");
        for (const prefix of ["seen:", "decision:", "assign:", "labels:", "status:", "sweep:"]) {
          context.storage.sql.exec("DELETE FROM cache WHERE key >= ? AND key < ?", prefix, `${prefix.slice(0, -1)};`);
        }
        this.store.set("migration:agent-bot", "1");
      }
    });
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
        } else if (routesAccount(settings, payload.accountId)) {
          await this.sweep(settings, chatwoot, payload.accountId);
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
        if (payload.type === "route" && job.attempts + 1 >= 3) {
          requestHandoff(this.store, payload.accountId, payload.conversationId);
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
    const key = `sweep:${accountId}:pending`;
    const saved = passSchema.safeParse(parseJson(this.store.get(key)));
    const pass = saved.success ? saved.data : { page: 1, remaining: await chatwoot.listInboxes(accountId), routed: [] };
    const inboxId = pass.remaining[0];
    if (inboxId !== undefined) {
      if ((await chatwoot.inboxBot(accountId, inboxId))?.id === settings.config.routing.botIds[String(accountId)]) {
        pass.routed.push(inboxId);
      }
      pass.remaining.shift();
    } else {
      const conversations = await chatwoot.listConversations(accountId, pass.page, "pending");
      for (const conversation of conversations) {
        if (
          conversation.id !== undefined &&
          conversation.inbox_id !== undefined &&
          pass.routed.includes(conversation.inbox_id)
        ) {
          this.enqueue({ type: "route", accountId, conversationId: conversation.id });
        }
      }
      if (conversations.length === 0) {
        this.store.delete(key);
        return;
      }
      pass.page += 1;
    }
    this.store.set(key, JSON.stringify(pass));
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
