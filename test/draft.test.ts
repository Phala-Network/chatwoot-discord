import { afterEach, describe, expect, it, vi } from "vitest";
import { latestDraft } from "../src/commands/draft.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { json, mockFetch, on, TRIAGE } from "./helpers.ts";

const THREAD = "100000000000001500";

function post(messages: Array<{ author: string; content: string }>) {
  mockFetch(
    on("GET", `discord.com/api/v10/channels/${THREAD}/messages`, () =>
      json(
        messages.map((message, index) => ({
          id: String(900 - index),
          author: { id: message.author },
          content: message.content,
        })),
      ),
    ),
  );
  return latestDraft(new DiscordRest("bot", (request) => fetch(request)), THREAD, TRIAGE);
}

afterEach(() => vi.restoreAllMocks());

describe("latestDraft", () => {
  it("takes the last code block of the triage bot's newest message that has one", async () => {
    const draft = await post([
      { author: TRIAGE, content: "Noted, no draft needed." },
      { author: "100000000000000011", content: "```\nnot the bot\n```" },
      { author: TRIAGE, content: "**Draft**\n```\nHi, try again.\n```" },
    ]);
    expect(draft).toEqual({ text: "Hi, try again." });
  });

  it("tells a missing draft from messages it cannot read (no Message Content intent)", async () => {
    expect(await post([{ author: "100000000000000011", content: "hello" }])).toEqual({ missing: "none" });
    expect(await post([{ author: TRIAGE, content: "" }])).toEqual({ missing: "unreadable" });
  });
});
