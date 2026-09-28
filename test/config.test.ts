import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.ts";

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
    expect(budget(33).success).toBe(false);
    expect(budget(34).success).toBe(true);
  });

  it("links agents by Chatwoot user id, each Discord and Chatwoot user once", () => {
    const issues = (agents: unknown[]) =>
      configSchema.safeParse({ ...minimal, agents }).error?.issues.map((issue) => issue.message);
    const alice = { discordUserId: "100000000000000011", chatwootUserId: 42 };
    const bob = { discordUserId: "100000000000000012", chatwootUserId: 43, tag: "Bob" };
    expect(issues([alice, bob])).toBeUndefined();
    expect(issues([{ ...alice, email: "alice@example.com" }])).toEqual([
      "email is no longer supported: link the agent with chatwootUserId instead",
    ]);
    expect(issues([{ discordUserId: alice.discordUserId, email: "alice@example.com" }])).toHaveLength(2);
    expect(issues([{ discordUserId: alice.discordUserId }])).toHaveLength(1);
    expect(issues([alice, { ...alice, discordUserId: bob.discordUserId }])).toEqual(["chatwootUserId must be unique"]);
    expect(issues([alice, { ...bob, discordUserId: alice.discordUserId }])).toEqual(["discordUserId must be unique"]);
  });

  it("bounds the triage bot's name, which its budget notes repeat", () => {
    expect(configSchema.safeParse({ ...minimal, triage: { name: "x".repeat(101) } }).success).toBe(false);
  });
});
