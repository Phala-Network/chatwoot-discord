// Durable private verification coverage for the WHOLE immutable, post-drain cut.
import type { RateLimitStore } from "../../../shared/rate-limit.ts";
import { type AdoptionCut, cutSchema, validateCut } from "./adoption.ts";
import { receiptHash } from "./history.ts";

export async function cutDigest(cut: AdoptionCut): Promise<string> {
  validateCut(cut);
  return receiptHash(cutSchema.parse(cut));
}
export async function verifyLinkBatch(
  cut: AdoptionCut,
  batch: number,
  store: RateLimitStore,
  verify: (part: AdoptionCut) => Promise<void>,
) {
  const digest = await cutDigest(cut);
  const batches = Math.ceil(cut.mappings.length / 2);
  if (!Number.isSafeInteger(batch) || batch < 0 || batch >= batches)
    throw new Error("Invalid complete-cut verification batch");
  const first = batch * 2;
  const end = Math.min(first + 2, cut.mappings.length);
  store.set(`adoption:verified:${digest}:${batch}`, "pending");
  await verify({ ...cut, mappings: cut.mappings.slice(first, end) });
  // Only successful fresh reads/repairs commit this receipt. A timeout/failure gives no coverage.
  const receipt = { digest, mappings: cut.mappings.length, batches, batch, first, end };
  store.set(`adoption:verified:${digest}:${batch}`, JSON.stringify(receipt));
  return receipt;
}
export async function assertVerifiedCut(cut: AdoptionCut, store: RateLimitStore) {
  const digest = await cutDigest(cut);
  const batches = Math.ceil(cut.mappings.length / 2);
  for (let batch = 0; batch < batches; batch++) {
    const expected = {
      digest,
      mappings: cut.mappings.length,
      batches,
      batch,
      first: batch * 2,
      end: Math.min(batch * 2 + 2, cut.mappings.length),
    };
    if (store.get(`adoption:verified:${digest}:${batch}`) !== JSON.stringify(expected))
      throw new Error("Complete post-drain link verification is required");
  }
  return { digest, mappings: cut.mappings.length, batches };
}
