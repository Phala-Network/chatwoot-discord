import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RateLimitStore } from "../../../../shared/rate-limit.ts";
import type { AdoptionCut } from "../../src/adoption.ts";
import { LegacyArchive } from "../../src/archive.ts";
import { type FrozenSource, type LegacyScanPage, legacyScanPage } from "../../src/legacy.ts";
import { verifyLinkBatch } from "../../src/verification.ts";

export async function withArchive<T>(
  sourceState: DurableObjectState,
  action: (archive: LegacyArchive, source: FrozenSource) => T | Promise<T>,
  dispositions?: (archive: LegacyArchive, source: FrozenSource) => void,
) {
  const source: FrozenSource = {
    sourceIdentity: sourceState.id.toString(),
    epoch: "fixture-frozen-cut",
    drainEvidence: "fixture:settled",
    frozen: true,
  };
  const pages: LegacyScanPage[] = [];
  let after = { kind: 0, rowid: 0 };
  for (let count = 0; count < 100; count++) {
    const page = await legacyScanPage(sourceState.storage.sql, source, after);
    pages.push(page);
    after = page.next;
    if (page.complete) break;
    if (count === 99) throw new Error("Fixture scan exceeded bound");
  }
  return runInDurableObject(
    env.LEGACY_HUB.getByName(`private-archive:${crypto.randomUUID()}`),
    async (_instance, state) => {
      const archive = new LegacyArchive(state.storage.sql, (run) => state.storage.transactionSync(run));
      archive.open(source);
      for (const page of pages) await archive.collect(page);
      dispositions?.(archive, source);
      for (let pages = 0; pages < 100; pages++) {
        if (archive.auditNext().complete) break;
        if (pages === 99) throw new Error("Fixture audit exceeded bound");
      }
      return action(archive, source);
    },
  );
}
export async function verifiedFixture(cut: AdoptionCut): Promise<RateLimitStore> {
  const saved = new Map<string, string>();
  const store = {
    get: (key: string) => saved.get(key),
    set: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  // These fixtures test history staging separately; real HTTP verification is covered in
  // adoption.test.ts. Still produce the exact durable complete-cut protocol receipts.
  for (let batch = 0; batch < Math.ceil(cut.mappings.length / 2); batch++)
    await verifyLinkBatch(cut, batch, store, async () => {});
  return store;
}
