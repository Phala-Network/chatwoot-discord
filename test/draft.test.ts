import { afterEach, describe, expect, it, vi } from "vitest";
import { draftFor } from "../src/commands/draft.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { json, mockFetch, on, type Recorded, TRIAGE } from "./helpers.ts";

const THREAD = "100000000000001500";
const CUSTOMER = "100000000000009000";
const AGENT = "100000000000000011";

/** The post's messages after the customer's, newest first; `to` is the message one replies to. */
function post(messages: Array<{ author: string; content: string; to?: string }>) {
  const mock = mockFetch(
    on("GET", `discord.com/api/v10/channels/${THREAD}/messages`, () =>
      json(
        messages.map((message, index) => ({
          id: String(9100 - index),
          author: { id: message.author },
          content: message.content,
          ...(message.to ? { message_reference: { message_id: message.to } } : {}),
        })),
      ),
    ),
  );
  const draft = draftFor(new DiscordRest("bot", (request) => fetch(request)), THREAD, CUSTOMER, TRIAGE);
  return { draft, requests: mock.requests as Recorded[] };
}

afterEach(() => vi.restoreAllMocks());

describe("draftFor", () => {
  it("takes the draft of the triage bot's answer to the customer message, found by its reply reference", async () => {
    const { draft, requests } = post([
      { author: TRIAGE, content: "```text\nAn answer to a later message.\n```", to: "100000000000009050" },
      { author: AGENT, content: "_Assigned to Bob_" },
      {
        author: TRIAGE,
        content: "**总结**：refund\n**草稿**：\n```text\nHi, the refund is on its way.\n```",
        to: CUSTOMER,
      },
      { author: TRIAGE, content: "Looking into it…" },
    ]);
    expect(await draft).toEqual({ text: "Hi, the refund is on its way." });
    expect(requests[0]?.url.searchParams.get("after")).toBe(CUSTOMER);
  });

  it("says whether the bot has not answered, answered without a draft, or cannot be read (no intent)", async () => {
    expect(await post([{ author: TRIAGE, content: "Looking into it…" }]).draft).toEqual({ missing: "unanswered" });
    expect(await post([{ author: TRIAGE, content: "疑似垃圾：广告。建议 /block", to: CUSTOMER }]).draft).toEqual({
      missing: "none",
    });
    expect(await post([{ author: TRIAGE, content: "", to: CUSTOMER }]).draft).toEqual({
      missing: "unreadable",
      answerId: "9100",
    });
  });
});
