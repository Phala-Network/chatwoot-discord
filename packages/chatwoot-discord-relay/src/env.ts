// Worker bindings. Non-secret settings live in the CONFIG var, or in CONFIG_STORE under CONFIG_KEY; the
// rest are Worker secrets.

import type { DiscordRateLimit, ThreadDirectory, TriageBudget } from "./control.ts";
import type { Conversation } from "./conversation.ts";
import type { QueueDigest } from "./digest.ts";
import type { ForumRegistry } from "./registry.ts";
import type { AccountSweep } from "./sweep.ts";

export interface Env {
  LEGACY_EXPORT_BOUNDARY?: import("./legacy.ts").FrozenSource;
  CONVERSATION: DurableObjectNamespace<Conversation>;
  THREAD_DIRECTORY: DurableObjectNamespace<ThreadDirectory>;
  TRIAGE_BUDGET: DurableObjectNamespace<TriageBudget>;
  ACCOUNT_SWEEP: DurableObjectNamespace<AccountSweep>;
  QUEUE_DIGEST: DurableObjectNamespace<QueueDigest>;
  FORUM_REGISTRY: DurableObjectNamespace<ForumRegistry>;
  DISCORD_RATE_LIMIT: DurableObjectNamespace<DiscordRateLimit>;
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
