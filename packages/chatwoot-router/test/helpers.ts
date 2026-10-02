import { buildSettings, configSchema, type Settings, secretsSchema } from "../src/config.ts";

export { json, mockFetch, on, type Recorded, type Route, takeUnmatched } from "../../../shared/test/http.ts";

export function testSettings(
  overrides: Record<string, unknown> = {},
  secretOverrides: Record<string, string> = {},
): Settings {
  return buildSettings(
    configSchema.parse({
      chatwoot: { baseUrl: "https://chatwoot.example.com" },
      routing: { accounts: { "1": { cloud: { assignee: 6, covers: "Cloud support." } } } },
      ...overrides,
    }),
    secretsSchema.parse({
      CHATWOOT_TOKEN: "agent-token",
      CHATWOOT_WEBHOOK_SECRETS: JSON.stringify({ "1": "secret-acme" }),
      TYPESAFE_API_KEY: "ts-key",
      ...secretOverrides,
    }),
  );
}
