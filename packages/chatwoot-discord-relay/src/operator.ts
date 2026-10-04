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

// Cold source reads and count audits have a private ten-second deadline. Online control
// calls retain their shorter deadline; no source read participates in online execution.
function sourceRead<T>(call: () => Promise<T>): Promise<T> {
  return within(call(), AbortSignal.timeout(10_000));
}

export function inventory(env: OperatorEnv, after = 0) {
  return sourceRead(() => env.LEGACY_HUB.getByName("global").inventory(after));
}

/** Verify a finite mapping page; retain the complete manifest separately for staging. */
export async function verifyAdoptionLinks(env: Env, cut: AdoptionCut, store: RateLimitStore): Promise<void> {
  if (cut.mappings.length > 2) throw new Error("Verify at most two mappings per call");
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
  await verifyLinks(cut, chatwoot, rest, settings.config.relay.linkAttribute, settings);
}

export {
  nextReceiptPosition,
  type ReceiptPage,
  type ReceiptPosition,
  type ReceiptSeal,
  receiptSeal,
  validateReceiptPage,
} from "./history.ts";
export {
  legacyAuditPage,
  legacyEscalationBaseline,
  legacyInventory,
  legacyKeyPage,
  legacyReceiptPage,
} from "./legacy.ts";

import type { ReceiptPosition } from "./history.ts";
export function receiptPage(env: OperatorEnv, accountId: number, conversationId: number, position?: ReceiptPosition) {
  return sourceRead(() => env.LEGACY_HUB.getByName("global").receiptPage(accountId, conversationId, position));
}
export function auditPage(env: OperatorEnv, after?: { kind: number; rowid: number }) {
  return sourceRead(() => env.LEGACY_HUB.getByName("global").auditPage(after));
}
export function keyPage(env: OperatorEnv, after = "") {
  return sourceRead(() => env.LEGACY_HUB.getByName("global").keyPage(after));
}

export function escalationBaseline(env: OperatorEnv) {
  return sourceRead(() => env.LEGACY_HUB.getByName("global").escalationBaseline());
}
