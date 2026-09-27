// Worker bindings. Non-secret settings live in the CONFIG var; the rest are Worker secrets.

declare namespace Cloudflare {
  interface Env {
    HUB: DurableObjectNamespace<import("./hub.ts").Hub>;
    /** JSON object (wrangler vars accept objects) or a JSON string; see config.ts. */
    CONFIG: unknown;
    DISCORD_BOT_TOKEN: string;
    DISCORD_PUBLIC_KEY: string;
    CHATWOOT_RELAY_TOKEN: string;
    CHATWOOT_WEBHOOK_SECRETS: string;
    CHATWOOT_AGENT_TOKENS?: string;
  }
}

interface Env extends Cloudflare.Env {}
