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
    // discord-api-types ships CommonJS that re-exports through helpers the Workers pool cannot
    // follow (its enums come through empty). Pre-bundle it to ESM, as wrangler does when deploying.
    deps: { optimizer: { ssr: { enabled: true, include: ["discord-api-types/v10"] } } },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          DISCORD_BOT_TOKEN: "test-bot-token",
          DISCORD_PUBLIC_KEY: publicHex,
          CHATWOOT_RELAY_TOKEN: "relay-token",
          TYPESAFE_API_KEY: "ts-key",
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
