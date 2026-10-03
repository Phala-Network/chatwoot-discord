import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// A throwaway Ed25519 key pair per run: the Worker verifies with the public key, tests sign
// interactions with the private key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const privateJwk = JSON.stringify(privateKey.export({ format: "jwk" }));

export default defineConfig({
  test: {
    // Structured logs from passing tests are noise; failures still print theirs.
    silent: "passed-only",
    setupFiles: ["./test/setup.ts"],
    // discord-api-types ships CommonJS that re-exports through helpers the Workers pool cannot
    // follow (its enums come through empty). Pre-bundle it to ESM, as the build does.
    deps: { optimizer: { ssr: { enabled: true, include: ["discord-api-types/v10"] } } },
  },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        // Keep in step with cloudflare.config.ts.
        compatibilityDate: "2026-08-15",
        // Required by @cloudflare/vitest-pool-workers (the Worker itself does not need it).
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          CONVERSATION: { className: "Conversation", useSQLite: true },
          THREAD_DIRECTORY: { className: "ThreadDirectory", useSQLite: true },
          TRIAGE_BUDGET: { className: "TriageBudget", useSQLite: true },
          FORUM_REGISTRY: { className: "ForumRegistry", useSQLite: true },
          ACCOUNT_SWEEP: { className: "AccountSweep", useSQLite: true },
          QUEUE_DIGEST: { className: "QueueDigest", useSQLite: true },
          DISCORD_RATE_LIMIT: { className: "DiscordRateLimit", useSQLite: true }
        },
        kvNamespaces: ["CONFIG_STORE"],
        bindings: {
          // Placeholder ids.
          CONFIG: {
            chatwoot: { baseUrl: "https://chatwoot.example.com" },
            accounts: [
              { id: 3, name: "Acme", forumChannelId: "100000000000000055" },
              { id: 1, name: "Globex", forumChannelId: "100000000000000055" },
            ],
            agents: [
              { discordUserId: "100000000000000011", chatwootUserId: 42 },
              { discordUserId: "100000000000000012", chatwootUserId: 43 },
              { discordUserId: "100000000000000013", chatwootUserId: 45 },
            ],
            forumTags: {
              "100000000000000055": { "account:3": "100000000000000301", "status:open": "100000000000000302" },
            },
            triage: { userId: "100000000000000777" },
          },
          DISCORD_BOT_TOKEN: "test-bot-token",
          DISCORD_PUBLIC_KEY: publicHex,
          CHATWOOT_RELAY_TOKEN: "relay-token",
          TRIAGE_HOOK_SECRET: "triage-hook-secret-0123456789abcdef",
          CHATWOOT_WEBHOOK_SECRETS: JSON.stringify({ "3": "secret-acme", "1": "secret-globex" }),
          CHATWOOT_AGENT_TOKENS: JSON.stringify({
            "100000000000000011": "token-alice",
            "100000000000000012": "token-bob",
          }),
          TEST_DISCORD_PRIVATE_JWK: privateJwk,
        },
      },
    }),
  ],
});
