import { afterEach, describe, expect, it, vi } from "vitest";
import { readDraft } from "../src/commands/draft.ts";
import { DiscordHttpError, DiscordRest } from "../src/discord/rest.ts";
import { json, mockFetch, on, TRIAGE } from "./helpers.ts";

const THREAD = "100000000000001500";
const ANSWER = "100000000000009100";

function answer(author: string, content: string, status = 200) {
  const mock = mockFetch(
    on("GET", `discord.com/api/v10/channels/${THREAD}/messages/${ANSWER}`, () =>
      status === 429
        ? json({ message: "rate limited", retry_after: 0, global: false }, { status: 429 })
        : json({ id: ANSWER, author: { id: author }, content }),
    ),
  );
  const draft = readDraft(new DiscordRest("bot", (request) => fetch(request)), THREAD, ANSWER, TRIAGE);
  return { draft, requests: mock.requests };
}

afterEach(() => vi.restoreAllMocks());

describe("readDraft", () => {
  it("takes the last code block of the triage bot's answer", async () => {
    const { draft } = answer(TRIAGE, "**总结**：refund\n**草稿**：\n```text\nHi, the refund is on its way.\n```");
    expect(await draft).toEqual({ text: "Hi, the refund is on its way." });
  });

  it("tells an answer without a draft from one it cannot read (no Message Content intent)", async () => {
    expect(await answer(TRIAGE, "疑似垃圾：广告。建议 /block").draft).toEqual({ missing: "none" });
    expect(await answer("100000000000000011", "```\nnot the bot's\n```").draft).toEqual({ missing: "none" });
    expect(await answer(TRIAGE, "").draft).toEqual({ missing: "unreadable" });
  });

  it("fails at once on a rate limit instead of retrying: someone is waiting", async () => {
    const { draft, requests } = answer(TRIAGE, "", 429);
    await expect(draft).rejects.toBeInstanceOf(DiscordHttpError);
    expect(requests).toHaveLength(1);
  });
});
