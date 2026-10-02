import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore, retryDelay } from "../../../shared/store.ts";
import type { Settings } from "./config.ts";
import type { Env } from "./env.ts";
import { awaitsRouting, routeConversation, routesAccount } from "./routing.ts";
import { loadSettings } from "./settings.ts";

export const ROUTER_NAME = "global";
const ROUTE_BUDGET = 18;
const RUN_WALL_MS = 5 * 60 * 1000;
const SWEEP_PASS_TTL_MS = 24 * 60 * 60 * 1000;
const id = z.number().int().positive();
const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("sweep"), accountId: id }),
]);
type Payload = z.infer<typeof jobSchema>;
const passSchema = z.object({ cutoff: z.number(), page: id, startedAt: z.number() });

export class Router extends DurableObject<Env> {
  private readonly store: QueueStore;

  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    this.store = new QueueStore(context.storage.sql);
    context.blockConcurrencyWhile(async () => this.store.migrate());
  }

  async enqueueConversation(accountId: number, conversationId: number): Promise<void> {
    const settings = await loadSettings(this.env);
    if (!routesAccount(settings, accountId) || conversationId <= settings.config.startAfterConversationId) return;
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
      const payload = parse(jobSchema, job.payload);
      if (!payload) {
        log.warn("unreadable job dropped", { job: job.key });
        this.store.deleteJob(job.key);
        continue;
      }
      if (budget.remaining < (payload.type === "route" ? ROUTE_BUDGET : 1) || Date.now() - started > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      try {
        if (payload.type === "route") {
          await routeConversation(
            { settings, chatwoot, store: this.store, fetch: budget.fetch },
            payload.accountId,
            payload.conversationId,
          );
        } else if (routesAccount(settings, payload.accountId)) {
          await this.sweep(settings, chatwoot, payload.accountId);
        }
        this.store.completeJob(job);
      } catch (error) {
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
    const lastKey = `sweep:${accountId}:last`;
    const passKey = `sweep:${accountId}:pass`;
    const now = Date.now();
    const { lookbackSeconds, maxCatchUpSeconds } = settings.config.reconcile;
    const last = Number(this.store.get(lastKey) ?? 0);
    const sinceLast = last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds;
    const window = Math.min(Math.max(sinceLast, lookbackSeconds), maxCatchUpSeconds);
    const pass = parse(passSchema, this.store.get(passKey)) ?? { cutoff: now / 1000 - window, page: 1, startedAt: now };
    const conversations = await chatwoot.listConversations(accountId, pass.page, "open");
    let finished = conversations.length === 0;
    for (const conversation of conversations) {
      if ((conversation.last_activity_at ?? 0) < pass.cutoff) {
        finished = true;
        break;
      }
      if (conversation.id !== undefined && awaitsRouting(settings, this.store, accountId, conversation)) {
        this.enqueue({ type: "route", accountId, conversationId: conversation.id });
      }
    }
    if (finished) {
      this.store.set(lastKey, String(pass.startedAt));
      this.store.delete(passKey);
    } else {
      this.store.set(passKey, JSON.stringify({ ...pass, page: pass.page + 1 }), SWEEP_PASS_TTL_MS);
      this.enqueue({ type: "sweep", accountId });
    }
  }

  private enqueue(payload: Payload): void {
    const key =
      payload.type === "route" ? `route:${payload.accountId}:${payload.conversationId}` : `sweep:${payload.accountId}`;
    this.store.enqueue(key, payload.type === "route" ? 0 : 1, JSON.stringify(payload));
  }

  private async schedule(at?: number): Promise<void> {
    const next = at ?? this.store.nextWakeup();
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

function parse<Schema extends z.ZodType>(schema: Schema, raw: string | undefined): z.infer<Schema> | undefined {
  if (raw === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
