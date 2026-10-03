// The supported npm deployment retains Hub during the rollback window, then deletes it.
import { bindings, defineConfig, exports } from "cf/config";
export default defineConfig(({ mode }) => ({
  worker: {
    name: "relay-package-consumer",
    entrypoint: mode === "retire-hub" ? "src/active.ts" : "src/index.ts",
    compatibilityDate: "2026-08-15",
    exports: {
      Hub:
        mode === "retire-hub"
          ? exports.durableObject({ state: "deleted" })
          : exports.durableObject({ storage: "sqlite" }),
      Conversation: exports.durableObject({ storage: "sqlite" }),
      ThreadDirectory: exports.durableObject({ storage: "sqlite" }),
      TriageBudget: exports.durableObject({ storage: "sqlite" }),
      AccountSweep: exports.durableObject({ storage: "sqlite" }),
      QueueDigest: exports.durableObject({ storage: "sqlite" }),
      ForumRegistry: exports.durableObject({ storage: "sqlite" }),
      DiscordRateLimit: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      CONVERSATION: bindings.durableObject({ worker: "relay-package-consumer", exportName: "Conversation" }),
      THREAD_DIRECTORY: bindings.durableObject({ worker: "relay-package-consumer", exportName: "ThreadDirectory" }),
      TRIAGE_BUDGET: bindings.durableObject({ worker: "relay-package-consumer", exportName: "TriageBudget" }),
      ACCOUNT_SWEEP: bindings.durableObject({ worker: "relay-package-consumer", exportName: "AccountSweep" }),
      QUEUE_DIGEST: bindings.durableObject({ worker: "relay-package-consumer", exportName: "QueueDigest" }),
      FORUM_REGISTRY: bindings.durableObject({ worker: "relay-package-consumer", exportName: "ForumRegistry" }),
      DISCORD_RATE_LIMIT: bindings.durableObject({ worker: "relay-package-consumer", exportName: "DiscordRateLimit" }),
    },
  },
}));
