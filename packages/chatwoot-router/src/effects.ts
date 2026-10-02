import { z } from "zod";
import { parseJson } from "../../../shared/json.ts";
import type { RoutingContext, RoutingStore } from "./routing.ts";

const effectSchema = z.object({
  inputId: z.number().int().min(0),
  kind: z.string().nullable(),
  handled: z.number().int().min(0),
});

export async function actOnce(
  ctx: RoutingContext,
  key: string,
  effect: z.infer<typeof effectSchema>,
  record: "before" | "after",
  act: () => Promise<unknown>,
): Promise<void> {
  if (ctx.store.get(key) !== undefined) return;
  if (record === "before") ctx.store.set(key, JSON.stringify({ ...effect, handled: 0 }));
  await act();
  ctx.store.set(key, JSON.stringify(effect));
}

export function readEffects(store: RoutingStore, accountId: number, conversationId: number) {
  return [
    store.get(`reply:${accountId}:${conversationId}`),
    ...["assign", "labels", "status"].flatMap((effect) =>
      store.list(`${effect}:${accountId}:${conversationId}:`, `${effect}:${accountId}:${conversationId};`),
    ),
  ]
    .flatMap((value) => {
      const parsed = effectSchema.safeParse(parseJson(value));
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) => left.inputId - right.inputId);
}
