import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";

describe("configuration", () => {
  it("still accepts the removed discord.applicationId key", () => {
    const config = configSchema.parse({
      chatwoot: { baseUrl: "https://chatwoot.example.com" },
      discord: { applicationId: "100000000000000001" },
      accounts: [{ id: 1, name: "Acme", forumChannelId: "100000000000000002" }],
    });
    expect(config).not.toHaveProperty("discord");
  });
});
