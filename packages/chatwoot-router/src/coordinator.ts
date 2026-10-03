import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { within } from "../../../shared/deadline.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore, retryDelay } from "../../../shared/store.ts";
import type { Env } from "./env.ts";
import { conversationName } from "./router.ts";
import { loadSettings } from "./settings.ts";

export const COORDINATOR_NAME = "global";
const sweepSchema = z.object({ accountId: z.number().int().positive(), status: z.enum(["pending", "open"]) });
const pageSchema = z.object({
  page: z.number().int().positive(),
});
const deliverySchema = z.object({
  accountId: z.number().int().positive(),
  conversationId: z.number().int().positive(),
});

/** Lists one page per alarm. Conversation state belongs exclusively to the conversation's Router. */
export class Coordinator extends DurableObject<Env> {
  private readonly store: QueueStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new QueueStore(ctx.storage.sql);
    this.store.migrate();
  }

  async requestSweep(): Promise<void> {
    for (const accountId of Object.keys((await loadSettings(this.env)).config.routing.accounts)) {
      for (const status of ["pending", "open"] as const) {
        this.store.enqueue(`sweep:${accountId}:${status}`, 0, JSON.stringify({ accountId: Number(accountId), status }));
      }
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.subrequestBudget);
    budget.startSlice();
    const job = this.store.nextDueJobs(1, "sweep:")[0];
    if (job) {
      const parsed = sweepSchema.safeParse(parseJson(job.payload));
      if (!parsed.success) this.store.deleteJob(job.key);
      else {
        try {
          const { accountId, status } = parsed.data;
          const chatwoot = chatwootClient(
            settings.config.chatwoot.baseUrl,
            settings.secrets.CHATWOOT_TOKEN,
            budget.fetch,
          );
          const saved = pageSchema.safeParse(parseJson(this.store.get(job.key)));
          const checkpoint = saved.success ? saved.data : { page: 1 };
          const botId = settings.config.routing.botIds[String(accountId)];
          const conversations = await chatwoot.listConversations(accountId, checkpoint.page, status);
          this.ctx.storage.transactionSync(() => {
            for (const conversation of conversations) {
              if (
                conversation.id !== undefined &&
                (status === "pending" ||
                  (conversation.meta?.assignee_type === "AgentBot" && conversation.meta.assignee?.id === botId))
              )
                this.store.enqueue(
                  `delivery:${accountId}:${conversation.id}`,
                  1,
                  JSON.stringify({ accountId, conversationId: conversation.id }),
                );
            }
            // IDs and the next page commit together, before any child RPC.
            if (conversations.length === 0) {
              this.store.delete(job.key);
              this.store.completeJob(job);
            } else {
              this.store.set(job.key, JSON.stringify({ page: checkpoint.page + 1 }));
              this.store.deferJob(job);
            }
          });
        } catch (error) {
          this.store.retryJob(job, retryDelay(job.attempts));
          log.warn("sweep page failed; will retry", { job: job.key, ...errorFields(error) });
        }
      }
    }
    const deliveries = this.store.nextDueJobs(12, "delivery:");
    for (let start = 0; start < deliveries.length; start += 3) {
      if (budget.remaining < 3) break;
      await Promise.all(
        deliveries.slice(start, start + 3).map(async (child) => {
          const target = deliverySchema.safeParse(parseJson(child.payload));
          if (!target.success) {
            this.store.deleteJob(child.key);
            return;
          }
          const { accountId, conversationId } = target.data;
          try {
            budget.consume();
            await within(
              this.env.ROUTER.getByName(conversationName(accountId, conversationId)).enqueueConversation(
                accountId,
                conversationId,
              ),
              budget.controlSignal(200),
            );
            this.store.completeJob(child);
          } catch (error) {
            this.store.retryJob(child, retryDelay(child.attempts));
            log.warn("sweep child delivery delayed", { accountId, conversationId, ...errorFields(error) });
          }
        }),
      );
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }
}
