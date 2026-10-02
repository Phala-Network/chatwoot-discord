import { z } from "zod";
import type { reconcileSchema } from "./config.ts";
import { parseJson } from "./json.ts";
import type { QueueStore } from "./store.ts";

const passSchema = z.object({ cutoff: z.number(), page: z.number().int().positive(), startedAt: z.number() });
const PASS_TTL_MS = 24 * 60 * 60 * 1000;

export function readSweepPass(
  store: QueueStore,
  accountId: number,
  reconcile: z.infer<typeof reconcileSchema>,
): z.infer<typeof passSchema> {
  const parsed = passSchema.safeParse(parseJson(store.get(`sweep:${accountId}:pass`)));
  if (parsed.success) return parsed.data;
  const now = Date.now();
  const last = Number(store.get(`sweep:${accountId}:last`) ?? 0);
  const { lookbackSeconds, maxCatchUpSeconds } = reconcile;
  const sinceLast = last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds;
  const window = Math.min(Math.max(sinceLast, lookbackSeconds), maxCatchUpSeconds);
  return { cutoff: now / 1000 - window, page: 1, startedAt: now };
}

export function saveSweepPass(
  store: QueueStore,
  accountId: number,
  pass: z.infer<typeof passSchema>,
  nextPage?: number,
): void {
  const key = `sweep:${accountId}:pass`;
  if (nextPage === undefined) {
    store.set(`sweep:${accountId}:last`, String(pass.startedAt));
    store.delete(key);
  } else {
    store.set(key, JSON.stringify({ ...pass, page: nextPage }), PASS_TTL_MS);
  }
}
