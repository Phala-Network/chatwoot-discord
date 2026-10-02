import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const router = defineWorker({
  name: "chatwoot-router",
  entrypoint,
  compatibilityDate: "2026-08-15",
  exports: { Router: exports.durableObject({ storage: "sqlite" }) },
});

export default defineConfig(({ mode }) => ({
  worker: {
    ...router,
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
    env: {
      ROUTER: bindings.durableObject({ worker: router, exportName: "Router" }),
      CHATWOOT_TOKEN: bindings.secret(),
      CHATWOOT_WEBHOOK_SECRETS: bindings.secret(),
      TYPESAFE_API_KEY: bindings.secret(),
      ...(mode === "development" && { CHATWOOT_BOT_TOKENS: bindings.secret() }),
      CONFIG: bindings.json({
        chatwoot: { baseUrl: "https://chatwoot.example.com" },
        routing: { accounts: { "1": { support: { assignee: 6, covers: "Product support and billing." } } } },
        startAfterConversationId: { "1": 0 },
      }),
    },
  },
}));
