import { z } from "zod";
import { messageWatermark, ROUTING_ATTRIBUTES } from "../../../shared/attributes.ts";
import type { ChatwootConversation } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import type { RoutingContext } from "./routing.ts";

const completionSchema = z.object({
  seen: z.number().int().min(0),
  handled: z.number().int().min(0),
  kind: z.string().nullable(),
});

function readCompletion(ctx: Pick<RoutingContext, "store">, accountId: number, conversationId: number) {
  const parsed = completionSchema.safeParse(parseJson(ctx.store.get(`completion:${accountId}:${conversationId}`)));
  return parsed.success ? parsed.data : { seen: 0, handled: 0, kind: null };
}

export function needsCompletionRepair(
  ctx: Pick<RoutingContext, "store">,
  accountId: number,
  conversation: ChatwootConversation,
): boolean {
  if (conversation.id === undefined) return false;
  const recorded = readCompletion(ctx, accountId, conversation.id);
  const current = conversation.custom_attributes ?? {};
  const names = ROUTING_ATTRIBUTES;
  return (
    recorded.seen > messageWatermark(current[names.seen]) ||
    recorded.handled > messageWatermark(current[names.handled]) ||
    (recorded.kind !== null && recorded.kind !== current[names.kind])
  );
}

export async function writeCompletion(
  ctx: RoutingContext,
  accountId: number,
  conversationId: number,
  seen = 0,
  handled = 0,
  kind: string | null = null,
): Promise<void> {
  const key = `completion:${accountId}:${conversationId}`;
  const previous = readCompletion(ctx, accountId, conversationId);
  const conversation = await ctx.chatwoot.getConversation(accountId, conversationId);
  if (!conversation) return;
  const current = conversation.custom_attributes ?? {};
  const names = ROUTING_ATTRIBUTES;
  const completion = {
    seen: Math.max(previous.seen, seen, messageWatermark(current[names.seen])),
    handled: Math.max(previous.handled, handled, messageWatermark(current[names.handled])),
    kind: kind ?? previous.kind,
  };
  if (completion.seen === 0 && completion.handled === 0 && completion.kind === null) return;
  ctx.store.set(key, JSON.stringify(completion));
  const attributes = {
    [names.seen]: completion.seen,
    ...(completion.handled > 0 ? { [names.handled]: completion.handled } : {}),
    ...(completion.kind === null ? {} : { [names.kind]: completion.kind }),
  };
  if (
    Object.entries(attributes).every(
      ([name, value]) => (name === names.kind ? current[name] : messageWatermark(current[name])) === value,
    )
  )
    return;
  await ctx.chatwoot.setCustomAttributes(accountId, conversationId, attributes);
}
