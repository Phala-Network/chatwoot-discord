// Copy with operator.ts into a separately reviewed operator project. Placeholder identities
// and CONFIG must be replaced from the sealed cut, never inferred from deployment names.
import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./operator.ts" with { type: "cf-worker" };

const relayName = "chatwoot-discord-relay";
const operator = defineWorker({
  name: "relay-adoption-operator",
  workersDev: false,
  previewUrls: false,
  entrypoint,
  compatibilityDate: "2026-08-15",
  exports: { RelayAdoptionOperator: exports.durableObject({ storage: "sqlite" }) },
});

export default defineConfig({
  worker: {
    ...operator,
    env: {
      LEGACY_HUB: bindings.durableObject({ worker: relayName, exportName: "Hub" }),
      CONVERSATION: bindings.durableObject({ worker: relayName, exportName: "Conversation" }),
      THREAD_DIRECTORY: bindings.durableObject({ worker: relayName, exportName: "ThreadDirectory" }),
      TRIAGE_BUDGET: bindings.durableObject({ worker: relayName, exportName: "TriageBudget" }),
      ACCOUNT_SWEEP: bindings.durableObject({ worker: relayName, exportName: "AccountSweep" }),
      QUEUE_DIGEST: bindings.durableObject({ worker: relayName, exportName: "QueueDigest" }),
      FORUM_REGISTRY: bindings.durableObject({ worker: relayName, exportName: "ForumRegistry" }),
      DISCORD_RATE_LIMIT: bindings.durableObject({ worker: relayName, exportName: "DiscordRateLimit" }),
      CONFIG: bindings.json({
        chatwoot: { baseUrl: "https://chatwoot.example.com" },
        accounts: [{ id: 3, name: "Example", forumChannelId: "100000000000000055" }],
        agents: [],
      }),
      DISCORD_BOT_TOKEN: bindings.secret(),
      DISCORD_PUBLIC_KEY: bindings.secret(),
      CHATWOOT_RELAY_TOKEN: bindings.secret(),
      CHATWOOT_WEBHOOK_SECRETS: bindings.secret(),
    },
  },
});
