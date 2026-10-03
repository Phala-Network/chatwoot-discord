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
  pending: z.array(z.number().int().positive()),
  empty: z.boolean(),
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
    const job = this.store.nextDueJob();
    if (!job) return;
    const parsed = sweepSchema.safeParse(parseJson(job.payload));
    if (!parsed.success) {
      this.store.deleteJob(job.key);
    } else {
      try {
        const settings = await loadSettings(this.env);
        const { accountId, status } = parsed.data;
        const budget = new Budget(settings.config.subrequestBudget);
        budget.startSlice();
        const chatwoot = chatwootClient(
          settings.config.chatwoot.baseUrl,
          settings.secrets.CHATWOOT_TOKEN,
          budget.fetch,
        );
        const saved = pageSchema.safeParse(parseJson(this.store.get(job.key)));
        const checkpoint = saved.success ? saved.data : { page: 1, pending: [], empty: false };
        const botId = settings.config.routing.botIds[String(accountId)];
        if (!checkpoint.pending.length) {
          const conversations = await chatwoot.listConversations(accountId, checkpoint.page, status);
          checkpoint.empty = conversations.length === 0;
          checkpoint.pending = conversations.flatMap((conversation) =>
            conversation.id !== undefined &&
            (status === "pending" ||
              (conversation.meta?.assignee_type === "AgentBot" && conversation.meta.assignee?.id === botId))
              ? [conversation.id]
              : [],
          );
          this.store.set(job.key, JSON.stringify(checkpoint));
        }
        const pending = [...checkpoint.pending];
        for (let offset = 0; offset < pending.length; offset += 3) {
          const batch = pending.slice(offset, offset + 3);
          const results = await Promise.allSettled(
            batch.map(async (id) => {
              budget.consume();
              await within(
                this.env.ROUTER.getByName(conversationName(accountId, id)).enqueueConversation(accountId, id),
                budget.controlSignal(200),
              );
            }),
          );
          results.forEach((result, index) => {
            if (result.status === "fulfilled")
              checkpoint.pending = checkpoint.pending.filter((id) => id !== batch[index]);
            else
              log.warn("sweep child delivery delayed", {
                accountId,
                conversationId: batch[index],
                ...errorFields(result.reason),
              });
          });
          this.store.set(job.key, JSON.stringify(checkpoint));
        }
        if (checkpoint.pending.length) this.store.retryJob(job, retryDelay(job.attempts));
        else {
          this.store.completeJob(job);
          if (checkpoint.empty) this.store.delete(job.key);
          else {
            this.store.set(job.key, JSON.stringify({ page: checkpoint.page + 1, pending: [], empty: false }));
            this.store.enqueue(job.key, 0, job.payload);
          }
        }
      } catch (error) {
        this.store.retryJob(job, retryDelay(job.attempts));
        log.warn("sweep page failed; will retry", { job: job.key, ...errorFields(error) });
      }
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }
}
