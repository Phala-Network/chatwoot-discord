// Worker bindings. Non-secret settings live in the CONFIG var, or in CONFIG_STORE under CONFIG_KEY; the
// rest are Worker secrets.

declare namespace Cloudflare {
  interface Env {
    HUB: DurableObjectNamespace<import("./hub.ts").Hub>;
    /** JSON object (wrangler vars accept objects) or a JSON string; see config.ts. */
    CONFIG?: unknown;
    /** Instead of CONFIG: the key of the configuration in CONFIG_STORE (see scripts/store-config.ts). */
    CONFIG_KEY?: string;
    CONFIG_STORE?: KVNamespace;
    DISCORD_BOT_TOKEN: string;
    DISCORD_PUBLIC_KEY: string;
    CHATWOOT_RELAY_TOKEN: string;
    CHATWOOT_WEBHOOK_SECRETS: string;
    CHATWOOT_AGENT_TOKENS?: string;
    CHATWOOT_BOT_TOKENS?: string;
    TYPESAFE_API_KEY?: string;
    TRIAGE_HOOK_SECRET?: string;
  }
}

interface Env extends Cloudflare.Env {}
