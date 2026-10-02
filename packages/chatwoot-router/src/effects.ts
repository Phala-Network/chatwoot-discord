import { z } from "zod";
import { parseJson } from "../../../shared/json.ts";
import type { RoutingContext, RoutingStore } from "./routing.ts";

const effectSchema = z.object({ kind: z.string().nullable(), handled: z.number().int().min(0) });

export async function actOnce(
  ctx: RoutingContext,
  key: string,
  kind: string | null,
  handled: number,
  act: () => Promise<unknown>,
): Promise<void> {
  if (ctx.store.get(key) !== undefined) return;
  ctx.store.set(key, JSON.stringify({ kind, handled: 0 }));
  await act();
  ctx.store.set(key, JSON.stringify({ kind, handled }));
}

export function readEffects(store: RoutingStore, accountId: number, conversationId: number) {
  return [store.get(`reply:${accountId}:${conversationId}`), ...store.list(`status:${accountId}:${conversationId}:`)]
    .flatMap((value) => {
      const parsed = effectSchema.safeParse(parseJson(value));
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) => left.handled - right.handled);
}
