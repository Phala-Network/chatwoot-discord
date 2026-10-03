import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { configSchema, parseSettings } from "../src/config.ts";
import type { Env } from "../src/env.ts";
import { loadSettings } from "../src/settings.ts";

const owners = { cloud: { assignee: 6, covers: "Cloud support." } };
const config = {
  chatwoot: { baseUrl: "https://chatwoot.example.com" },
  routing: { botIds: { "1": 1 }, accounts: { "1": owners } },
};
const secrets = {
  CHATWOOT_TOKEN: "agent-token",
  CHATWOOT_AGENT_BOT_TOKENS: '{"1":"bot-token"}',
  CHATWOOT_AGENT_BOT_SECRETS: '{"1":"test-secret"}',
  TYPESAFE_API_KEY: "test-key",
};

describe("router configuration", () => {
  it("defaults the endpoint to TypeSafe's System One API", () => {
    expect(parseSettings(config, secrets).config.routing.endpoint).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it.each(["http://jev.example.com/v1/systemone", "ftp://jev.example.com/v1/systemone", "not a URL"])(
    "rejects an invalid or non-HTTPS endpoint for TypeSafe's System One API: %s",
    (endpoint) => {
      expect(() => parseSettings({ ...config, routing: { ...config.routing, endpoint } }, secrets)).toThrow(
        /routing.endpoint/,
      );
    },
  );

  it("rejects configurable coordination names", () => {
    expect(configSchema.safeParse({ ...config, attributes: { seen: "custom" } }).success).toBe(false);
  });

  it.each(["CHATWOOT_AGENT_BOT_SECRETS", "CHATWOOT_AGENT_BOT_TOKENS"])(
    "requires %s for exactly the routed accounts",
    (name) => {
      for (const value of ["{}", '{"1":""}', '{"1":"value","2":"extra"}', '{"2":"value"}']) {
        expect(() => parseSettings(config, { ...secrets, [name]: value })).toThrow(name);
      }
    },
  );

  it.each([
    {},
    { "1": 0 },
    { "1": -1 },
    { "1": 1.5 },
    { "1": "1" },
    { "1": 9007199254740992 },
    { "2": 1 },
    { "1": 1, "2": 2 },
  ])("rejects mismatched or invalid bot ids %j", (botIds) => {
    expect(configSchema.safeParse({ ...config, routing: { ...config.routing, botIds } }).success).toBe(false);
  });

  it.each(["startAfterConversationId", "reconcile"])("rejects removed setting %s", (name) => {
    expect(configSchema.safeParse({ ...config, [name]: {} }).success).toBe(false);
  });

  it("validates owners, reserved names, kinds, and label families", () => {
    const valid = (routing: object) => configSchema.safeParse({ ...config, routing }).success;
    expect(valid({ accounts: { "1": {} } })).toBe(false);
    expect(valid({ accounts: { "0": owners } })).toBe(false);
    expect(valid({ accounts: { "9007199254740992": owners } })).toBe(false);
    expect(valid({ accounts: { "1": { unclear: owners.cloud } } })).toBe(false);
    expect(valid({ ...config.routing, kinds: { "2": { spam: { covers: "Spam." } } } })).toBe(false);
    expect(valid({ ...config.routing, kinds: { "1": { none: { covers: "None." } } } })).toBe(false);
    expect(valid({ ...config.routing, kinds: { "1": { spam: { covers: "Spam.", status: "pending" } } } })).toBe(false);
    expect(valid({ ...config.routing, topics: { spam: "Spam." }, kinds: { "1": { spam: { covers: "Spam." } } } })).toBe(
      false,
    );
    expect(valid({ ...config.routing, kinds: { "1": { spam: { covers: "Spam.", status: "resolved" } } } })).toBe(true);
  });

  it("requires TypeSafe and a bot even without canned responses", () => {
    expect(() => parseSettings(config, { ...secrets, TYPESAFE_API_KEY: undefined })).toThrow(/TYPESAFE_API_KEY/);
    expect(parseSettings(config, secrets).secrets.CHATWOOT_AGENT_BOT_TOKENS["1"]).toBe("bot-token");
    expect(() => parseSettings(config, { ...secrets, CHATWOOT_AGENT_BOT_TOKENS: undefined })).toThrow(
      /CHATWOOT_AGENT_BOT_TOKENS/,
    );
  });

  it("loads JSON and KV configuration, rejects ambiguous or unavailable sources, and retries failed reads", async () => {
    const bindings: Env = env;
    const { CONFIG, ...stored } = bindings;
    expect(
      (await loadSettings({ ...env, ...secrets, CONFIG: JSON.stringify(config) })).config.routing.accounts["1"],
    ).toEqual(owners);
    await expect(loadSettings({ ...env, CONFIG_KEY: "key" })).rejects.toThrow(/either CONFIG or CONFIG_KEY/);
    const later = { ...stored, CONFIG_KEY: "later" };
    await expect(loadSettings(later)).rejects.toThrow(/not in CONFIG_STORE/);
    await bindings.CONFIG_STORE?.put("later", JSON.stringify(CONFIG));
    expect((await loadSettings(later)).config.routing.botIds).toEqual({ "1": 1, "2": 2 });
  });
});
