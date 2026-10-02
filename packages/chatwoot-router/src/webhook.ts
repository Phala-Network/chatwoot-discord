import { z } from "zod";

const id = z.number().int().positive();
const eventSchema = z.object({
  event: z.string(),
  account: z.object({ id }),
  id: id.optional(),
  conversation: z.object({ id }).optional(),
  message_type: z.union([z.string(), z.number()]).optional(),
  private: z.boolean().optional(),
  updated_at: z.number().optional(),
  changed_attributes: z
    .array(z.object({ status: z.object({ previous_value: z.string(), current_value: z.string() }).optional() }))
    .optional(),
  sender: z.object({ type: z.string().optional() }).nullish(),
});

const CONVERSATION_EVENTS = new Set([
  "conversation_opened",
  "conversation_resolved",
  "conversation_updated",
  "conversation_status_changed",
]);

export interface Transition {
  status: string;
  at: number;
}

export function eventTarget(
  payload: unknown,
): { accountId: number; conversationId: number; transition?: Transition } | undefined {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  if (CONVERSATION_EVENTS.has(event.event) && event.id !== undefined) {
    const change = event.changed_attributes?.find((entry) => entry.status)?.status;
    return {
      accountId: event.account.id,
      conversationId: event.id,
      ...(change &&
      (change.previous_value === "pending" ||
        change.current_value === "resolved" ||
        (change.current_value === "pending" && change.previous_value !== "resolved")) &&
      event.updated_at !== undefined
        ? { transition: { status: change.current_value, at: event.updated_at } }
        : {}),
    };
  }
  if (
    event.event === "message_created" &&
    (event.message_type === "incoming" || event.message_type === 0) &&
    !event.private &&
    event.sender?.type === "contact" &&
    event.id !== undefined &&
    event.conversation
  ) {
    return { accountId: event.account.id, conversationId: event.conversation.id };
  }
  return undefined;
}
