import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildSettings, configSchema, secretsSchema } from "../src/config.ts";
import { loadSettings } from "../src/settings.ts";

const minimal = {
  chatwoot: { baseUrl: "https://chatwoot.example.com" },
  accounts: [{ id: 1, name: "Acme", forumChannelId: "100000000000000002" }],
};

describe("configuration", () => {
  it("rejects unknown keys, so a typo does not silently fall back to a default", () => {
    // Including the discord.applicationId key that 0.2.0 removed.
    expect(configSchema.safeParse({ ...minimal, discord: { applicationId: "1" } }).success).toBe(false);
    expect(configSchema.safeParse({ ...minimal, relay: { maxChunk: 2 } }).success).toBe(false);
    expect(configSchema.safeParse({ ...minimal, triages: {} }).success).toBe(false);
    const account = { ...minimal.accounts[0], forumChannel: "100000000000000002" };
    expect(configSchema.safeParse({ ...minimal, accounts: [account] }).success).toBe(false);
  });

  it("requires a subrequest budget that fits a run's setup and one message of relay.maxChunks parts", () => {
    const budget = (subrequestBudget: number) =>
      configSchema.safeParse({ ...minimal, relay: { maxChunks: 10, subrequestBudget } });
    // Accepted before, though a run's setup left too little for the message: it yielded forever.
    const result = budget(25);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["relay.subrequestBudget"]);
    expect(budget(37).success).toBe(false);
    expect(budget(38).success).toBe(true);
  });

  it("links agents by Chatwoot user id, each Discord and Chatwoot user once", () => {
    const issues = (agents: unknown[]) =>
      configSchema.safeParse({ ...minimal, agents }).error?.issues.map((issue) => issue.message);
    const alice = { discordUserId: "100000000000000011", chatwootUserId: 42 };
    const bob = { discordUserId: "100000000000000012", chatwootUserId: 43 };
    expect(issues([alice, bob])).toBeUndefined();
    // Tags are bound by id in forumTags, never by an agent's name.
    expect(issues([{ ...bob, tag: "Bob" }])).toEqual(['Unrecognized key: "tag"']);
    expect(issues([{ ...alice, email: "alice@example.com" }])).toHaveLength(1);
    expect(issues([{ discordUserId: alice.discordUserId, email: "alice@example.com" }])).toHaveLength(2);
    expect(issues([{ discordUserId: alice.discordUserId }])).toHaveLength(1);
    expect(issues([alice, { ...alice, discordUserId: bob.discordUserId }])).toEqual(["chatwootUserId must be unique"]);
    expect(issues([alice, { ...bob, discordUserId: alice.discordUserId }])).toEqual(["discordUserId must be unique"]);
  });

  it("binds forum tags by id to what they stand for", () => {
    const forumTags = (tags: Record<string, string>) =>
      configSchema.safeParse({ ...minimal, forumTags: { "100000000000000055": tags } }).success;
    const tag = "100000000000000301";
    expect(
      forumTags({
        "account:3": tag,
        "status:snoozed": tag,
        "assignee:none": tag,
        "assignee:42": tag,
        "priority:urgent": tag,
        "topic:Technical support": tag,
        "label:web3": tag,
      }),
    ).toBe(true);
    expect(forumTags({ "status:closed": tag })).toBe(false);
    expect(forumTags({ Open: tag })).toBe(false);
    expect(forumTags({ "status:open": "Open" })).toBe(false);
  });

  it("escalates the queue to a role or a user, not both", () => {
    const queue = (escalation: object) =>
      configSchema.safeParse({ ...minimal, queue: { channelId: "100000000000000900", ...escalation } }).success;
    expect(queue({ escalationRoleId: "100000000000000901" })).toBe(true);
    expect(queue({ escalationUserId: "100000000000000902" })).toBe(true);
    expect(queue({ escalationRoleId: "100000000000000901", escalationUserId: "100000000000000902" })).toBe(false);
  });

  it("routes only configured accounts, and only with a TypeSafe key", () => {
    const owners = { cloud: { assignee: 6, covers: "Cloud support." } };
    const routing = (accounts: Record<string, unknown>) =>
      configSchema.safeParse({ ...minimal, routing: { accounts } });
    expect(routing({ "1": owners }).data?.routing?.minConfidence).toBe(0.7);
    expect(routing({ "2": owners }).error?.issues.map((issue) => issue.path.join("."))).toEqual(["routing.accounts"]);
    expect(routing({ "1": { unclear: owners.cloud } }).success).toBe(false);
    expect(routing({ "1": {} }).success).toBe(false);

    const kinds = (given: Record<string, unknown>) =>
      configSchema.safeParse({ ...minimal, routing: { accounts: { "1": owners }, kinds: given } });
    expect(kinds({ "1": { spam: { covers: "Spam.", status: "resolved" } } }).success).toBe(true);
    expect(kinds({ "1": { spam: { covers: "Spam.", status: "resolved", cannedResponse: "hi" } } }).success).toBe(false);
    expect(kinds({ "1": { spam: { covers: "Spam.", status: "pending" } } }).success).toBe(false);
    expect(kinds({ "1": { none: { covers: "Nothing." } } }).success).toBe(false);
    // Kinds and topics are labels of two families: no name in both.
    const clash = configSchema.safeParse({
      ...minimal,
      routing: { accounts: { "1": owners }, topics: { spam: "Spam." }, kinds: { "1": { spam: { covers: "Spam." } } } },
    });
    expect(clash.error?.issues.map((issue) => issue.path.join("."))).toEqual(["routing.kinds"]);
    expect(
      kinds({ "2": { spam: { covers: "Spam.", status: "resolved" } } }).error?.issues.map((issue) =>
        issue.path.join("."),
      ),
    ).toEqual(["routing.kinds"]);

    const secrets = (extra: Record<string, string> = {}) =>
      secretsSchema.parse({
        DISCORD_BOT_TOKEN: "bot",
        DISCORD_PUBLIC_KEY: "0".repeat(64),
        CHATWOOT_RELAY_TOKEN: "relay",
        CHATWOOT_WEBHOOK_SECRETS: "{}",
        ...extra,
      });
    const config = configSchema.parse({ ...minimal, routing: { accounts: { "1": owners } } });
    expect(() => buildSettings(config, secrets())).toThrow(/TYPESAFE_API_KEY/);
    expect(buildSettings(config, secrets({ TYPESAFE_API_KEY: "key" })).config.routing?.accounts["1"]).toEqual(owners);

    // A kind that replies needs its account's agent bot, which sends the reply.
    const replying = configSchema.parse({
      ...minimal,
      routing: {
        accounts: { "1": owners },
        kinds: { "1": { security: { covers: "Security.", cannedResponse: "security" } } },
      },
    });
    expect(() => buildSettings(replying, secrets({ TYPESAFE_API_KEY: "key" }))).toThrow(/CHATWOOT_BOT_TOKENS/);
    const withBot = secrets({ TYPESAFE_API_KEY: "key", CHATWOOT_BOT_TOKENS: JSON.stringify({ "1": "bot" }) });
    expect(buildSettings(replying, withBot).botToken(1)).toBe("bot");
  });

  it("requires a subrequest budget that fits the support queue", () => {
    const queue = { channelId: "100000000000000900" };
    const accounts = Array.from({ length: 11 }, (_, i) => ({ ...minimal.accounts[0], id: i + 1 }));
    expect(configSchema.safeParse({ ...minimal, queue }).success).toBe(true);
    const result = configSchema.safeParse({ ...minimal, accounts, queue });
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["relay.subrequestBudget"]);
  });

  it("bounds the triage bot's name, which its budget notes repeat", () => {
    expect(configSchema.safeParse({ ...minimal, triage: { name: "x".repeat(101) } }).success).toBe(false);
  });
});

describe("loadSettings", () => {
  it("reads the configuration from CONFIG_STORE under CONFIG_KEY, instead of CONFIG", async () => {
    const { CONFIG, ...stored } = env;
    await env.CONFIG_STORE?.put("config-test", JSON.stringify(CONFIG));

    const settings = await loadSettings({ ...stored, CONFIG_KEY: "config-test" });
    expect(settings.config.accounts.map((account) => account.id)).toEqual([3, 1]);
    await expect(loadSettings({ ...stored, CONFIG_KEY: "config-missing" })).rejects.toThrow(/not in CONFIG_STORE/);
    await expect(loadSettings({ ...env, CONFIG_KEY: "config-test" })).rejects.toThrow(/either CONFIG or CONFIG_KEY/);
  });

  it("reads again after a failed read", async () => {
    const { CONFIG, ...stored } = env;
    const settingsEnv = { ...stored, CONFIG_KEY: "config-later" };
    await expect(loadSettings(settingsEnv)).rejects.toThrow(/not in CONFIG_STORE/);

    await env.CONFIG_STORE?.put("config-later", JSON.stringify(CONFIG));
    expect((await loadSettings(settingsEnv)).config.accounts).toHaveLength(2);
  });
});
