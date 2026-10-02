import { describe, expect, it } from "vitest";
import { isAnsweringReply, toRelayConversation } from "../../../shared/chatwoot/api.ts";
import { Notifier } from "../src/relay/notify.ts";
import { MemoryStore, message, TRIAGE } from "./helpers.ts";

const NOW = new Date("2026-09-27T20:00:00Z");
const SECONDS = NOW.getTime() / 1000;
const triage = { userId: TRIAGE, name: "Triage bot", perConversationPerHour: 5, perHour: 30 };
const notifier = (store = new MemoryStore()) => new Notifier({ store, triage, liveSeconds: 3600, now: () => NOW });

describe("native bot notification decisions", () => {
  it.each(["resolved", "snoozed", "pending"])("does not call triage for a %s conversation", (status) => {
    const store = new MemoryStore();
    expect(
      notifier(store)
        .notification(message({ createdAt: SECONDS, conversation: { status } }))
        .lines.join("\n"),
    ).not.toContain(`<@${TRIAGE}>`);
    expect(store.counters.size).toBe(0);
  });

  it("keeps each message's answer or mention decision through retries", () => {
    const notifications = notifier();
    const answered = message({ createdAt: SECONDS, answered: true });
    const first = notifications.notification(answered);
    expect(first.lines.join("\n")).toContain("handled automatically");
    answered.answered = false;
    expect(notifications.notification(answered)).toEqual(first);
    const later = message({ id: 102, createdAt: SECONDS });
    const mention = notifications.notification(later);
    expect(mention.lines).toEqual([`-# <@${TRIAGE}>`]);
    later.answered = true;
    expect(notifications.notification(later)).toEqual(mention);
  });

  it("keeps history, automatic email, private notes and outgoing messages silent", () => {
    for (const customer of [
      message({ createdAt: SECONDS - 3601 }),
      message({ autoReply: true }),
      message({ private: true }),
      message({ messageType: "outgoing" }),
    ]) {
      expect(notifier().notification(customer).lines).toEqual([]);
    }
  });

  it("does not mistake a bot id for a person with the same numeric id", () => {
    const bot = toRelayConversation(9, {
      meta: { assignee: { id: 42, name: "Brand bot" }, assignee_type: "AgentBot" },
    });
    expect(bot.assignee).toBeNull();
    expect(bot.assigneeType).toBe("AgentBot");
    const user = toRelayConversation(9, { meta: { assignee: { id: 42, name: "User" }, assignee_type: "User" } });
    expect(user.assignee).toEqual({ id: 42, name: "User" });
  });
});

describe("answering replies", () => {
  it.each([
    { message_type: 1, sender: { type: "user" } },
    { message_type: 1, sender: { type: "agent_bot" } },
    { message_type: 1, status: "delivered" },
  ])("counts an actual public reply %j", (reply) => expect(isAnsweringReply({ id: 2, ...reply })).toBe(true));

  it.each([
    { message_type: 0 },
    { message_type: 2 },
    { message_type: 3 },
    { message_type: 1, private: true },
    { message_type: 1, status: "failed" },
    { message_type: 1, content_attributes: { deleted: true } },
    { message_type: 1, content_attributes: { email: { auto_reply: true } } },
  ])("does not count %j as an answer", (reply) => expect(isAnsweringReply({ id: 2, ...reply })).toBe(false));
});
