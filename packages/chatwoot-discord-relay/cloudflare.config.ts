// Worker configuration. The CONFIG values below are placeholders: replace them with your Chatwoot URL, account ids,
// forum channel id, and agents before relying on the relay (see the configuration reference in README.md). Secrets are
// listed in .dev.vars.example and uploaded with `cf deploy --secrets-file <file>`, never here.
import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// This Worker, which defines the Hub Durable Object; the HUB binding names it so that its type is inferred.
const relay = defineWorker({
  name: "chatwoot-discord-relay",
  entrypoint,
  // Keep in step with vitest.config.ts.
  compatibilityDate: "2026-08-15",
  exports: { Hub: exports.durableObject({ storage: "sqlite" }) },
});

export default defineConfig(({ mode }) => ({
  worker: {
    ...relay,
    observability: { enabled: true },
    // Reconciliation sweep. The Free plan allows 5 cron triggers per account; this uses one.
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
    env: {
      HUB: bindings.durableObject({ worker: relay, exportName: "Hub" }),
      // Secrets (see .dev.vars.example). A declared secret is required: a deploy fails while one is not set. The
      // optional ones are declared in development only, so `npm run dev` loads them from .dev.vars too.
      DISCORD_BOT_TOKEN: bindings.secret(),
      DISCORD_PUBLIC_KEY: bindings.secret(),
      CHATWOOT_RELAY_TOKEN: bindings.secret(),
      // Relay account webhook secrets; agent-bot credentials belong only to the router.
      CHATWOOT_WEBHOOK_SECRETS: bindings.secret(),
      ...(mode === "development" && {
        CHATWOOT_AGENT_TOKENS: bindings.secret(),
        TRIAGE_HOOK_SECRET: bindings.secret(),
      }),
      CONFIG: bindings.json({
        chatwoot: { baseUrl: "https://chatwoot.example.com" },
        accounts: [
          { id: 1, name: "Acme", forumChannelId: "100000000000000002" },
          { id: 2, name: "Globex", forumChannelId: "100000000000000002" },
        ],
        agents: [
          { discordUserId: "100000000000000011", chatwootUserId: 1 },
          { discordUserId: "100000000000000012", chatwootUserId: 2 },
        ],
        triage: { userId: "100000000000000021", name: "Triage bot" },
        relay: { maxChunks: 4, topicAttribute: "topic", linkAttribute: "discord_thread" },
      }),
    },
  },
}));
