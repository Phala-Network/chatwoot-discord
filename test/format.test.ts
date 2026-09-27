import { describe, expect, it } from "vitest";
import {
  body,
  CONTENT_LIMIT,
  draftFromMessage,
  draftFromTriage,
  postHeader,
  senderName,
  split,
  TITLE_LIMIT,
  threadTitle,
} from "../src/relay/format.js";
import { message } from "./helpers.js";

describe("format", () => {
  it("titles name the account, conversation, and customer", () => {
    expect(threadTitle(message())).toBe("[Acme #12] Jane Doe — My agent will not connect");
    expect(threadTitle(message({ emailSubject: "Billing question" }))).toBe("[Acme #12] Jane Doe — Billing question");
    expect(Array.from(threadTitle(message({ content: "x".repeat(500) }))).length).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(threadTitle(message({ content: "  " }))).toBe("[Acme #12] Jane Doe");
  });

  it("usernames distinguish customers, agents, and activity", () => {
    expect(senderName(message())).toBe("Jane Doe");
    expect(senderName(message({ messageType: "outgoing", sender: { name: "Sam", type: "user" } }))).toBe("Sam · Acme");
    expect(senderName(message({ messageType: "outgoing", sender: { type: "user" } }))).toBe("Agent · Acme");
    expect(senderName(message({ messageType: "outgoing", sender: { type: "agent_bot" } }))).toBe("Bot · Acme");
    expect(senderName(message({ messageType: "activity" }))).toBe("Chatwoot");
    expect(senderName(message({ sender: { name: "Discord fan" } }))).not.toMatch(/discord/i);
    expect(senderName(message({ sender: { name: "Clyde" } }))).not.toMatch(/clyde/i);
    expect(senderName(message({ sender: { email: "who@example.com" } }))).toBe("who@example.com");
  });

  it("marks private notes, activity, and attachments", () => {
    expect(body(message({ messageType: "outgoing", private: true, content: "Refund approved" }))).toBe(
      "🔒 **Internal note**\nRefund approved",
    );
    expect(body(message({ messageType: "activity", content: "Resolved by Sam" }))).toBe("_Resolved by Sam_");
    expect(body(message({ content: "", attachmentUrls: ["https://files.example.com/a.png"] }))).toBe(
      "📎 https://files.example.com/a.png",
    );
  });

  it("header shows channel, inbox, and email", () => {
    expect(postHeader(message())).toBe("-# via Live chat · Acme — Product App\n-# jane@example.com");
    expect(postHeader(message({ inboxName: null, conversation: { channel: "Channel::Line", contact: {} } }))).toBe(
      "-# via Line",
    );
  });

  it("splits long content under Discord's limit without losing text", () => {
    const chunks = split("line\n".repeat(1000));
    expect(chunks.every((chunk) => chunk.length <= CONTENT_LIMIT)).toBe(true);
    expect(chunks.join("").match(/line/g)).toHaveLength(1000);
    // No line break to cut at: hard cut, without splitting a surrogate pair.
    const emoji = split("😀".repeat(1500));
    expect(emoji.every((chunk) => chunk.length <= CONTENT_LIMIT && !chunk.includes("�"))).toBe(true);
    expect(emoji.join("")).toBe("😀".repeat(1500));
  });

  it("extracts the draft after a label from a triage message", () => {
    const triage =
      "**Summary**: wants account deletion\n**Basis**:\n```\ncli conv 15\n```\n**Draft**:\n```text\nHi, you can delete it in Settings.\n```\n-# Reply with this";
    expect(draftFromTriage(triage, ["Draft"])).toBe("Hi, you can delete it in Settings.");
    expect(draftFromTriage("**Draft**:\n\n```\nHi there,\n\nThanks!\n```", ["Draft"])).toBe("Hi there,\n\nThanks!");
    expect(draftFromTriage("**Brouillon**:\n```\nBonjour\n```", ["Draft", "Brouillon"])).toBe("Bonjour");
    expect(draftFromTriage("```\nprogress output\n```", ["Draft"])).toBeUndefined();
    // Labels are literal text, not patterns.
    expect(draftFromTriage("**D.aft**:\n```\nx\n```", ["D.aft"])).toBe("x");
    expect(draftFromTriage("**Draft**:\n```\nx\n```", ["D.aft"])).toBeUndefined();
  });

  it("uses the last code block, or the whole message, from anyone else", () => {
    expect(draftFromMessage("Try this:\n```\nold\n```\nor\n```\nHi, please log in again.\n```")).toBe(
      "Hi, please log in again.",
    );
    expect(draftFromMessage(" Thanks for waiting! ")).toBe("Thanks for waiting!");
  });
});
