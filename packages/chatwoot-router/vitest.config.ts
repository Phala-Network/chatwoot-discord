import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { silent: "passed-only", setupFiles: ["./test/setup.ts"] },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-15",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { ROUTER: { className: "Router", useSQLite: true } },
        kvNamespaces: ["CONFIG_STORE"],
        bindings: {
          CONFIG: {
            chatwoot: { baseUrl: "https://chatwoot.example.com" },
            routing: { accounts: { "1": { cloud: { assignee: 6, covers: "Cloud support." } } } },
            startAfterConversationId: 10,
          },
          CHATWOOT_TOKEN: "agent-token",
          CHATWOOT_WEBHOOK_SECRETS: JSON.stringify({ "1": "secret-acme", "2": "secret-globex" }),
          TYPESAFE_API_KEY: "ts-key",
        },
      },
    }),
  ],
});
