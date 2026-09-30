import { afterEach, describe, expect, it, vi } from "vitest";
import { draftAbove } from "../src/commands/draft.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { json, mockFetch, on, type Recorded, TRIAGE } from "./helpers.ts";

const THREAD = "100000000000001500";
const BUTTONS = "100000000000009000";
const AGENT = "100000000000000011";

/** The post's messages before the buttons' message, newest first. */
function post(messages: Array<{ author: string; content: string }>) {
  const mock = mockFetch(
    on("GET", `discord.com/api/v10/channels/${THREAD}/messages`, () =>
      json(
        messages.map((message, index) => ({
          id: String(8999 - index),
          author: { id: message.author },
          content: message.content,
        })),
      ),
    ),
  );
  const draft = draftAbove(new DiscordRest("bot", (request) => fetch(request)), THREAD, BUTTONS, TRIAGE);
  return { draft, requests: mock.requests as Recorded[] };
}

afterEach(() => vi.restoreAllMocks());

describe("draftAbove", () => {
  it("takes the draft of the answer the buttons are under, not a newer or an older one", async () => {
    const { draft, requests } = post([
      { author: AGENT, content: "_Assigned to Bob_" },
      { author: TRIAGE, content: "**总结**：refund\n**草稿**：\n```text\nHi, the refund is on its way.\n```" },
      { author: TRIAGE, content: "```text\nAn older draft.\n```" },
    ]);
    expect(await draft).toEqual({ text: "Hi, the refund is on its way." });
    expect(requests[0]?.url.searchParams.get("before")).toBe(BUTTONS);
  });

  it("tells an answer without a draft from one it cannot read (no Message Content intent)", async () => {
    expect(await post([{ author: TRIAGE, content: "疑似垃圾：广告。建议 /block" }]).draft).toEqual({ missing: "none" });
    expect(await post([{ author: AGENT, content: "hello" }]).draft).toEqual({ missing: "none" });
    expect(await post([{ author: TRIAGE, content: "" }]).draft).toEqual({ missing: "unreadable" });
  });
});
