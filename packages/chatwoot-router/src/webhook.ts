import { z } from "zod";

const id = z.number().int().positive();
const eventSchema = z.object({
  event: z.string(),
  account: z.object({ id }),
  id: id.optional(),
  conversation: z.object({ id }).optional(),
  message_type: z.union([z.string(), z.number()]).optional(),
  private: z.boolean().optional(),
  sender: z.object({ type: z.string().optional() }).nullish(),
});

const CONVERSATION_EVENTS = new Set(["conversation_created", "conversation_updated", "conversation_status_changed"]);

export function eventTarget(
  payload: unknown,
): { accountId: number; conversationId: number; messageId?: number } | undefined {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  if (CONVERSATION_EVENTS.has(event.event) && event.id !== undefined) {
    return { accountId: event.account.id, conversationId: event.id };
  }
  if (
    event.event === "message_created" &&
    (event.message_type === "incoming" || event.message_type === 0) &&
    !event.private &&
    event.sender?.type === "contact" &&
    event.id !== undefined &&
    event.conversation
  ) {
    return { accountId: event.account.id, conversationId: event.conversation.id, messageId: event.id };
  }
  return undefined;
}
