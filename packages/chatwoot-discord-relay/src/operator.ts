// Operator-only preparation. No HTTP importer and no online legacy read fallback.
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import type { RateLimitStore } from "../../../shared/rate-limit.ts";
import { type AdoptionCut, verifyLinks } from "./adoption.ts";
import { DiscordLimiter } from "./discord/limiter.ts";
import { DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import type { Hub } from "./hub.ts";
import { control } from "./rpc.ts";
import { loadSettings } from "./settings.ts";

export {
  type AdoptionCut,
  type AdoptionMapping,
  cutSchema,
  stageAdoption,
  validateCut,
  verifyLinks,
} from "./adoption.ts";

export interface OperatorEnv extends Env {
  LEGACY_HUB: DurableObjectNamespace<Hub>;
}

export function inventory(env: OperatorEnv, after = 0) {
  return control(undefined, () => env.LEGACY_HUB.getByName("global").inventory(after));
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
  await verifyLinks(cut, chatwoot, rest, settings.config.relay.linkAttribute);
}
