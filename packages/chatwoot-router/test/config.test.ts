import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { configSchema, parseSettings } from "../src/config.ts";
import type { Env } from "../src/env.ts";
import { loadSettings } from "../src/settings.ts";

const owners = { cloud: { assignee: 6, covers: "Cloud support." } };
const config = {
  chatwoot: { baseUrl: "https://chatwoot.example.com" },
  routing: { accounts: { "1": owners } },
};
const secrets = {
  CHATWOOT_TOKEN: "agent-token",
  CHATWOOT_WEBHOOK_SECRETS: '{"1":"test-secret"}',
  TYPESAFE_API_KEY: "test-key",
};

describe("router configuration", () => {
  it("defaults the coordination names, cutover, and reconcile window", () => {
    const parsed = configSchema.parse(config);
    expect(parsed.attributes).toEqual({ seen: "routing_seen", handled: "routing_handled", kind: "routing_kind" });
    expect(parsed.startAfterConversationId).toEqual({});
    expect(parsed.routing.minConfidence).toBe(0.7);
    expect(parsed.reconcile.lookbackSeconds).toBe(3600);
    expect(configSchema.safeParse({ ...config, attributes: { seen: "same", handled: "same" } }).success).toBe(false);
  });

  it("accepts per-account cutovers only for routed accounts", () => {
    const parsed = configSchema.parse({
      ...config,
      routing: { accounts: { "1": owners, "2": owners } },
      startAfterConversationId: { "1": 100, "2": 0 },
    });
    expect(parsed.startAfterConversationId).toEqual({ "1": 100, "2": 0 });
    expect(configSchema.safeParse({ ...config, startAfterConversationId: { "2": 100 } }).success).toBe(false);
  });

  it.each([
    0,
    100,
    { "1": -1 },
    { "1": 1.5 },
    { "1": "5" },
    { "1": 9007199254740992 },
    { "0": 5 },
    { "01": 5 },
    { "9007199254740992": 5 },
  ])("rejects an invalid cutover map %j", (startAfterConversationId) => {
    expect(configSchema.safeParse({ ...config, startAfterConversationId }).success).toBe(false);
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

  it("requires TypeSafe and each replying account's bot, but no Discord secrets", () => {
    expect(() => parseSettings(config, { ...secrets, TYPESAFE_API_KEY: undefined })).toThrow(/TYPESAFE_API_KEY/);
    expect(parseSettings(config, secrets).botToken(1)).toBeUndefined();
    const replying = {
      ...config,
      routing: { ...config.routing, kinds: { "1": { security: { covers: "Security.", cannedResponse: "security" } } } },
    };
    expect(() => parseSettings(replying, secrets)).toThrow(/CHATWOOT_BOT_TOKENS/);
    expect(parseSettings(replying, { ...secrets, CHATWOOT_BOT_TOKENS: '{"1":"bot-token"}' }).botToken(1)).toBe(
      "bot-token",
    );
  });

  it("loads JSON and KV configuration, rejects ambiguous or unavailable sources, and retries failed reads", async () => {
    const bindings: Env = env;
    const { CONFIG, ...stored } = bindings;
    expect((await loadSettings({ ...env, CONFIG: JSON.stringify(config) })).config.routing.accounts["1"]).toEqual(
      owners,
    );
    await expect(loadSettings({ ...env, CONFIG_KEY: "key" })).rejects.toThrow(/either CONFIG or CONFIG_KEY/);
    const later = { ...stored, CONFIG_KEY: "later" };
    await expect(loadSettings(later)).rejects.toThrow(/not in CONFIG_STORE/);
    await bindings.CONFIG_STORE?.put("later", JSON.stringify(CONFIG));
    expect((await loadSettings(later)).config.startAfterConversationId).toEqual({ "1": 10, "2": 2 });
  });
});
