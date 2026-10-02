// Worker bindings. Non-secret settings live in the CONFIG var, or in CONFIG_STORE under CONFIG_KEY; the
// rest are Worker secrets.

import type { Hub } from "./hub.ts";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  /** JSON object (a JSON binding) or a JSON string; see config.ts. */
  CONFIG?: unknown;
  /** Instead of CONFIG: the key of the configuration in CONFIG_STORE (see scripts/store-config.ts). */
  CONFIG_KEY?: string;
  CONFIG_STORE?: KVNamespace;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  CHATWOOT_RELAY_TOKEN: string;
  CHATWOOT_WEBHOOK_SECRETS: string;
  CHATWOOT_AGENT_TOKENS?: string;
  TRIAGE_HOOK_SECRET?: string;
}
