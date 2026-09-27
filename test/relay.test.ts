import { beforeEach, describe, expect, it } from "vitest";
import { CONTENT_LIMIT } from "../src/relay/format.js";
import { Relay, type RelayOptions } from "../src/relay/relay.js";
import { FakeForum, FORUM, MemoryStore, message, TAGS, TRIAGE } from "./helpers.js";

function relayWith(options: Partial<RelayOptions> = {}) {
  const forum = options.forum instanceof FakeForum ? options.forum : new FakeForum();
  const store = new MemoryStore();
  const relay = new Relay({
    forum,
    store,
    frontendUrl: "https://chatwoot.example.com/",
    target: (accountId) => ({ forumChannelId: FORUM, tag: accountId === 3 ? "Acme" : "Globex" }),
    topicAttribute: "topic",
    maxChunks: 4,
    ...options,
  });
  return { relay, forum, store };
}

const triage = { userId: TRIAGE, name: "Triage bot", perConversationPerHour: 5, perHour: 30 };
const resolved = { status: "resolved" };

describe("Relay", () => {
  let forum: FakeForum;
  let relay: Relay;

  beforeEach(() => {
    ({ relay, forum } = relayWith());
  });

  it("opens a tagged post with a ticket card, then posts the message as a reply", async () => {
    expect(await relay.relay(message())).toBe("relayed");
    const [[cardThread, card], [messageThread, first]] = forum.calls as [
      [string | undefined, Record<string, unknown>],
      [string | undefined, Record<string, unknown>],
    ];
    expect(cardThread).toBeUndefined();
    expect(card).toMatchObject({
      thread_name: "[Acme #12] Jane Doe — My agent will not connect",
      applied_tags: ["t-acme", "t-open"],
      username: "Chatwoot",
      content:
        "-# via Live chat · Acme — Product App\n-# jane@example.com\n[Open in Chatwoot](<https://chatwoot.example.com/app/accounts/3/conversations/12>)",
      allowed_mentions: { parse: [] },
    });
    expect(messageThread).toBe("thread-1");
    expect(first).toEqual({
      content: "My agent will not connect",
      username: "Jane Doe",
      allowed_mentions: { parse: [] },
    });
    expect(forum.patches).toEqual([]);
  });

  it("links a new post from its conversation once", async () => {
    const links: unknown[] = [];
    ({ relay, forum } = relayWith({ linkPost: async (...args) => void links.push(args) }));
    await relay.relay(message());
    await relay.relay(message({ id: 102, content: "Still broken" }));
    expect(links).toEqual([[3, 12, "https://discord.com/channels/100000000000000044/thread-1"]]);
  });

  it("keeps relaying when the link cannot be recorded", async () => {
    const ignored: unknown[] = [];
    ({ relay, forum } = relayWith({
      linkPost: async () => {
        throw new Error("Chatwoot unavailable");
      },
      onIgnoredError: (error) => ignored.push(error),
    }));
    expect(await relay.relay(message())).toBe("relayed");
    expect(forum.calls).toHaveLength(2);
    expect(ignored).toHaveLength(1);
  });

  it("posts follow-ups into the same post under the sender's name, with their avatar", async () => {
    await relay.relay(message());
    await relay.relay(
      message({
        id: 102,
        messageType: "outgoing",
        content: "Run the login command",
        sender: { name: "Sam", type: "user", avatarUrl: "https://files.example.com/sam.png" },
      }),
    );
    const [thread, payload] = forum.calls.at(-1) ?? [];
    expect(thread).toBe("thread-1");
    expect(payload).toMatchObject({ username: "Sam · Acme", avatar_url: "https://files.example.com/sam.png" });
    expect(forum.patches).toEqual([]);
  });

  it("resolving posts the activity, then retags and archives; a new message reopens", async () => {
    await relay.relay(message());
    await relay.relay(
      message({ id: 103, messageType: "activity", content: "Resolved by Sam", conversation: resolved }),
    );
    expect(forum.calls.at(-1)?.[1].content).toBe("_Resolved by Sam_");
    expect(forum.patches.at(-1)).toEqual(["thread-1", { applied_tags: ["t-acme", "t-resolved"], archived: true }]);

    await relay.relay(message({ id: 104, content: "Still broken" }));
    expect(forum.patches.at(-1)).toEqual(["thread-1", { applied_tags: ["t-acme", "t-open"], archived: false }]);
    expect(forum.patches).toHaveLength(2);
  });

  it("archives a resolved post again after any message", async () => {
    await relay.relay(message({ conversation: resolved }));
    await relay.relay(
      message({ id: 105, messageType: "outgoing", private: true, content: "note", conversation: resolved }),
    );
    expect(forum.patches.map(([, patch]) => patch)).toEqual([
      { applied_tags: ["t-acme", "t-resolved"], archived: true },
      { applied_tags: ["t-acme", "t-resolved"], archived: true },
    ]);
  });

  it("sync without a new message only patches when the state changed", async () => {
    await relay.relay(message());
    const conversation = message().conversation;
    await relay.sync(3, conversation, "thread-1", false);
    expect(forum.patches).toEqual([]);
    await relay.sync(3, { ...conversation, status: "resolved" }, "thread-1", false);
    await relay.sync(3, { ...conversation, status: "resolved" }, "thread-1", false);
    expect(forum.patches).toEqual([["thread-1", { applied_tags: ["t-acme", "t-resolved"], archived: true }]]);
  });

  it("tags the topic and the assignee, at most five tags", async () => {
    const tagged = new FakeForum({ ...TAGS, unassigned: "t-none", billing: "t-billing", sam: "t-sam" });
    ({ relay, forum } = relayWith({ forum: tagged }));
    await relay.relay(message({ conversation: { customAttributes: { topic: "Billing" } } }));
    expect(forum.calls[0]?.[1].applied_tags).toEqual(["t-acme", "t-open", "t-none", "t-billing"]);

    const assigned = { customAttributes: { topic: "Billing" }, assignee: { name: "Sam" } };
    await relay.relay(
      message({ id: 106, messageType: "activity", content: "Assigned to Sam", conversation: assigned }),
    );
    await relay.relay(message({ id: 107, messageType: "outgoing", content: "On it", conversation: assigned }));
    expect(forum.patches.map(([, patch]) => patch)).toEqual([
      { applied_tags: ["t-acme", "t-open", "t-sam", "t-billing"], archived: false },
    ]);
  });

  it("skips templates and empty messages", async () => {
    expect(await relay.relay(message({ messageType: "template" }))).toBe("skipped");
    expect(await relay.relay(message({ content: "  " }))).toBe("empty");
    expect(forum.calls).toEqual([]);
  });

  it("recreates the post when the Discord thread was deleted", async () => {
    await relay.relay(message());
    forum.failThreadWith = "gone";
    await relay.relay(message({ id: 102, content: "still broken" }));
    expect(forum.calls.map(([thread]) => thread)).toEqual([undefined, "thread-1", undefined, "thread-3"]);
    expect(forum.calls.at(-1)?.[1].content).toBe("still broken");
  });

  it("lets other Discord errors propagate for a retry", async () => {
    await relay.relay(message());
    forum.failThreadWith = "error";
    await expect(relay.relay(message({ id: 102 }))).rejects.toThrow("Discord HTTP 500");
  });

  it("gives separate accounts separate posts and tags", async () => {
    await relay.relay(message());
    await relay.relay(message({ id: 300, account: { id: 1, name: "Globex" } }));
    expect(forum.calls.map(([thread]) => thread)).toEqual([undefined, "thread-1", undefined, "thread-3"]);
    expect(forum.calls[2]?.[1].thread_name).toMatch(/^\[Globex #12\]/);
    expect(forum.calls[2]?.[1].applied_tags).toEqual(["t-globex", "t-open"]);
  });

  it("mentions the triage bot on customer messages only", async () => {
    ({ relay, forum } = relayWith({ triage }));
    await relay.relay(message());
    await relay.relay(message({ id: 102, content: "x ".repeat(1500) }));
    await relay.relay(
      message({ id: 103, messageType: "outgoing", content: "Try again", sender: { name: "Sam", type: "user" } }),
    );
    await relay.relay(message({ id: 104, messageType: "outgoing", private: true, content: "Known issue" }));
    await relay.relay(message({ id: 105, messageType: "activity", content: "Assigned to Sam" }));
    const contents = forum.contents();
    expect(contents[0]).not.toContain(`<@${TRIAGE}>`); // ticket card
    expect(contents[1]).toBe(`My agent will not connect\n-# <@${TRIAGE}>`);
    expect(contents[2]?.endsWith(`\n-# <@${TRIAGE}>`)).toBe(true);
    expect(contents[2]?.length).toBeLessThanOrEqual(CONTENT_LIMIT);
    expect(contents.filter((content) => content.includes(`<@${TRIAGE}>`))).toHaveLength(2);
    // Mentions never ping: the webhook message allows none.
    expect(forum.calls.every(([, payload]) => payload.allowed_mentions?.parse?.length === 0)).toBe(true);
  });

  it("calls the triage bot within its hourly budgets", async () => {
    ({ relay, forum } = relayWith({ triage }));
    for (let i = 0; i < 7; i += 1) await relay.relay(message({ id: 200 + i, content: `msg ${i}` }));
    const tagged = forum.contents().filter((content) => content.startsWith("msg"));
    expect(tagged.filter((content) => content.endsWith(`<@${TRIAGE}>`))).toHaveLength(5);
    expect(tagged.at(-1)).toMatch(/Triage bot not called: more than 5 customer messages in this conversation/);

    for (let i = 0; i < 30; i += 1) {
      await relay.relay(message({ id: 300 + i, conversation: { id: 1000 + i } }));
    }
    expect(forum.contents().at(-1)).toMatch(/Triage bot not called: more than 30 customer messages this hour/);
  });

  it("does not use up the triage budget when a message is retried", async () => {
    ({ relay, forum } = relayWith({ triage }));
    await relay.relay(message());
    for (let i = 0; i < 5; i += 1) {
      forum.failThreadWith = "error";
      await expect(relay.relay(message({ id: 102, content: "retried" }))).rejects.toThrow();
    }
    await relay.relay(message({ id: 102, content: "retried" }));
    await relay.relay(message({ id: 103, content: "next" }));
    expect(forum.contents().at(-1)?.endsWith(`<@${TRIAGE}>`)).toBe(true);
  });

  it("caps very long messages with a link to the full text", async () => {
    const text = `${"x".repeat(1900)}\n`.repeat(10);
    await relay.relay(message({ content: text }));
    const replies = forum.contents().slice(1);
    expect(replies).toHaveLength(5);
    expect(replies.every((content) => content.length <= CONTENT_LIMIT)).toBe(true);
    expect(replies.at(-1)).toBe(
      `-# Message truncated (${text.trim().length} characters). Full text: <https://chatwoot.example.com/app/accounts/3/conversations/12>`,
    );
  });

  it("mutes blocked contacts but still posts activity", async () => {
    const blocked = { status: "resolved", contact: { name: "Spammer", blocked: true } };
    expect(await relay.relay(message({ conversation: blocked }))).toBe("muted");
    expect(forum.calls).toEqual([]);
    expect(
      await relay.relay(
        message({ messageType: "activity", content: "Sam muted the conversation", conversation: blocked }),
      ),
    ).toBe("relayed");
  });

  it("pings a newly assigned, linked agent once, allowing only that mention", async () => {
    ({ relay, forum } = relayWith({ discordUserFor: (assignee) => (assignee.id === 7 ? "592" : undefined) }));
    await relay.relay(message());
    expect(forum.calls.some(([, payload]) => payload.allowed_mentions?.users)).toBe(false);

    const assigned = { assignee: { id: 7, name: "Kim" } };
    await relay.relay(
      message({ id: 110, messageType: "activity", content: "Assigned to Kim by Sam", conversation: assigned }),
    );
    const ping = forum.calls.at(-1)?.[1];
    expect(ping?.content).toBe("_Assigned to Kim by Sam_\n-# Assigned to <@592>");
    expect(ping?.allowed_mentions).toEqual({ parse: [], users: ["592"] });

    await relay.relay(message({ id: 111, messageType: "outgoing", content: "On it", conversation: assigned }));
    expect(forum.calls.at(-1)?.[1].allowed_mentions).toEqual({ parse: [] });

    const unlinked = { assignee: { id: 9, name: "Bot" } };
    await relay.relay(
      message({ id: 112, messageType: "activity", content: "Assigned to Bot", conversation: unlinked }),
    );
    expect(forum.calls.at(-1)?.[1].allowed_mentions).toEqual({ parse: [] });
  });

  it("pings in the first message when a conversation is assigned at creation", async () => {
    ({ relay, forum } = relayWith({ triage, discordUserFor: () => "592" }));
    await relay.relay(message({ conversation: { assignee: { id: 7, name: "Kim" } } }));
    const [card, first] = forum.calls.map(([, payload]) => payload);
    expect(card?.allowed_mentions).toEqual({ parse: [] });
    expect(first?.content).toBe(`My agent will not connect\n-# <@${TRIAGE}>\n-# Assigned to <@592>`);
    expect(first?.allowed_mentions).toEqual({ parse: [], users: ["592"] });
  });

  it("does not mention anyone without a configured triage bot", async () => {
    await relay.relay(message());
    expect(forum.contents().some((content) => content.includes("<@"))).toBe(false);
  });

  it("posts a failure notice into the existing post", async () => {
    await relay.relay(message());
    await relay.notifyFailure(3, 12, 555);
    expect(forum.calls.at(-1)?.[0]).toBe("thread-1");
    expect(forum.contents().at(-1)).toContain("message 555 could not be relayed");
  });
});
