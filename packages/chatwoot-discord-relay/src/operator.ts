// Operator-only preparation. No HTTP importer and no online legacy read fallback.
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { within } from "../../../shared/deadline.ts";
import type { RateLimitStore } from "../../../shared/rate-limit.ts";
import { type AdoptionCut, verifyLinks } from "./adoption.ts";
import { DiscordLimiter } from "./discord/limiter.ts";
import { DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import type { Hub } from "./hub.ts";
import { loadSettings } from "./settings.ts";

export {
  type AdoptionCut,
  type AdoptionMapping,
  cutSchema,
  importAdoptionPage,
  prepareAdoption,
  sealAdoptionHistory,
  stageAdoption,
  validateCut,
  verifyLinks,
} from "./adoption.ts";

export interface OperatorEnv extends Env {
  LEGACY_HUB: DurableObjectNamespace<Hub>;
}

// This deadline bounds caller waiting only. It DOES NOT cancel a source RPC/SQLite read.
// The source must already be frozen; retries use the identical durable checkpoint.
function sourceRead<T>(call: () => Promise<T>): Promise<T> {
  return within(call(), AbortSignal.timeout(10_000));
}
export function scanPage(env: OperatorEnv, source: FrozenSource, after?: LegacyPosition) {
  return sourceRead(() => env.LEGACY_HUB.getByName("global").scanPage(source, after));
}

/** Pass the complete immutable cut plus a zero-based batch index, never a subset cut. */
export async function verifyAdoptionLinks(env: Env, cut: AdoptionCut, store: RateLimitStore, batch: number) {
  const settings = await loadSettings(env);
  const budget = new Budget(settings.config.relay.subrequestBudget);
  budget.startSlice();
  const rest = new DiscordRest(
    settings.secrets.DISCORD_BOT_TOKEN,
    budget.fetch,
    new DiscordLimiter(store, env, budget),
  );
  const chatwoot = chatwootClient(
    settings.config.chatwoot.baseUrl,
    settings.secrets.CHATWOOT_RELAY_TOKEN,
    budget.fetch,
    store,
  );
  return verifyLinkBatch(cut, batch, store, (part) =>
    verifyLinks(part, chatwoot, rest, settings.config.relay.linkAttribute, settings),
  );
}

export { LegacyArchive } from "./archive.ts";
export {
  nextReceiptPosition,
  type ReceiptPage,
  type ReceiptPosition,
  type ReceiptSeal,
  receiptSeal,
  validateReceiptPage,
} from "./history.ts";
export {
  type FrozenSource,
  type LegacyPosition,
  type LegacyScanPage,
  legacyEscalationBaseline,
  legacyScanPage,
  validateFrozenSource,
} from "./legacy.ts";
export { assertVerifiedCut, cutDigest, verifyLinkBatch } from "./verification.ts";

import type { FrozenSource, LegacyPosition } from "./legacy.ts";
import { verifyLinkBatch } from "./verification.ts";
export function escalationBaseline(env: OperatorEnv, source: FrozenSource) {
  return sourceRead(() => env.LEGACY_HUB.getByName("global").escalationBaseline(source));
}
