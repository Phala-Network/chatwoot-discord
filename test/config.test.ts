import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.ts";

const minimal = {
  chatwoot: { baseUrl: "https://chatwoot.example.com" },
  accounts: [{ id: 1, name: "Acme", forumChannelId: "100000000000000002" }],
};

describe("configuration", () => {
  it("still accepts the removed discord.applicationId key", () => {
    const config = configSchema.parse({ ...minimal, discord: { applicationId: "100000000000000001" } });
    expect(config).not.toHaveProperty("discord");
  });

  it("rejects unknown keys, so a typo does not silently fall back to a default", () => {
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

  it("bounds the triage bot's name, which its budget notes repeat", () => {
    expect(configSchema.safeParse({ ...minimal, triage: { name: "x".repeat(101) } }).success).toBe(false);
  });
});
