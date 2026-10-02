import { z } from "zod";
import { messageWatermark } from "../../../shared/attributes.ts";
import { parseJson } from "../../../shared/json.ts";
import type { RoutingContext } from "./routing.ts";

const completionSchema = z.object({
  seen: z.number().int().min(0),
  handled: z.number().int().min(0),
  kind: z.string().nullable(),
});

export async function writeCompletion(
  ctx: RoutingContext,
  accountId: number,
  conversationId: number,
  seen: number,
  handled: number,
  kind: string | null,
): Promise<void> {
  const key = `completion:${accountId}:${conversationId}`;
  const parsed = completionSchema.safeParse(parseJson(ctx.store.get(key)));
  const previous = parsed.success ? parsed.data : { seen: 0, handled: 0, kind: null };
  const conversation = await ctx.chatwoot.getConversation(accountId, conversationId);
  if (!conversation) return;
  const current = conversation.custom_attributes ?? {};
  const names = ctx.settings.config.attributes;
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
  if (Object.entries(attributes).every(([name, value]) => current[name] === value)) return;
  await ctx.chatwoot.setCustomAttributes(accountId, conversationId, attributes);
}
