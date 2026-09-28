import { describe, expect, it } from "vitest";
import {
  body,
  CONTENT_LIMIT,
  chatwootMentions,
  draftFromMessage,
  draftFromTriage,
  postHeader,
  senderName,
  split,
  TITLE_LIMIT,
  tagNames,
  threadTitle,
  titleSubject,
} from "../src/relay/format.ts";
import type { RelayMessage } from "../src/relay/types.ts";
import { message } from "./helpers.ts";

function title(relayMessage: RelayMessage): string {
  return threadTitle(relayMessage.account.name, relayMessage.conversation, titleSubject(relayMessage));
}

describe("format", () => {
  it("titles name the account, conversation, and customer", () => {
    expect(title(message())).toBe("[Acme #12] Jane Doe — My agent will not connect");
    expect(title(message({ emailSubject: "Billing question" }))).toBe("[Acme #12] Jane Doe — Billing question");
    expect(Array.from(title(message({ content: "x".repeat(500) }))).length).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(title(message({ content: "  " }))).toBe("[Acme #12] Jane Doe");
    // A contact without a name shows their email; "discord" stays readable in titles.
    expect(title(message({ content: "Discord login", conversation: { contact: { email: "j@example.com" } } }))).toBe(
      "[Acme #12] j@example.com — Discord login",
    );
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
    expect(
      body(message({ content: "", attachments: [{ type: "file", url: "https://files.example.com/a.png" }] })),
    ).toBe("📎 https://files.example.com/a.png");
  });

  it("describes shared contacts and locations, which have no file", () => {
    const shared = message({
      content: "",
      attachments: [
        { type: "contact", name: "Ana Lima", phone: "+5511999990000" },
        { type: "contact", name: "", phone: "+15550100" },
        { type: "location", title: "Main St 1", latitude: 52.52, longitude: 13.405, url: "" },
        { type: "location", title: "", latitude: 1.5, longitude: -2, url: "https://maps.example.com/p" },
      ],
    });
    expect(body(shared)).toBe(
      [
        "📇 Ana Lima: +5511999990000",
        "📇 +15550100",
        "📍 Main St 1 · 52.52, 13.405",
        "📍 1.5, -2 https://maps.example.com/p",
      ].join("\n"),
    );
  });

  it("turns Chatwoot mentions into names, or Discord mentions of linked agents", () => {
    const note =
      "[@Kim Lee](mention://user/7/Kim%20Lee) and [@Billing](mention://team/2/Billing), see [@Sam](mention://user/8/Sam)";
    expect(chatwootMentions(note)).toBe("@Kim Lee and @Billing, see @Sam");
    expect(chatwootMentions(note, new Map([[7, "592"]]))).toBe("<@592> and @Billing, see @Sam");
    // A team id never matches a user's.
    expect(chatwootMentions("[@Billing](mention://team/7/Billing)", new Map([[7, "592"]]))).toBe("@Billing");
  });

  it("orders tags account, status, assignee, topic, priority, then labels", () => {
    const conversation = message({
      conversation: {
        priority: "urgent",
        labels: ["vip", "refund"],
        customAttributes: { topic: "Billing" },
      },
    }).conversation;
    expect(tagNames("Acme", "Kim", conversation, "topic")).toEqual([
      "Acme",
      "open",
      "Kim",
      "Billing",
      "urgent",
      "vip",
      "refund",
    ]);
  });

  it("header shows channel, inbox, email, and the phone number on phone channels", () => {
    expect(postHeader(message())).toBe("-# via Live chat · Acme — Product App\n-# jane@example.com");
    const phone = { email: null, phone: "+15550100" };
    expect(postHeader(message({ inboxName: null, conversation: { channel: "Channel::Line", contact: phone } }))).toBe(
      "-# via LINE",
    );
    expect(
      postHeader(message({ inboxName: null, conversation: { channel: "Channel::Whatsapp", contact: phone } })),
    ).toBe("-# via WhatsApp\n-# +15550100");
    expect(postHeader(message({ inboxName: null, conversation: { channel: "Channel::Future", contact: {} } }))).toBe(
      "-# via Future",
    );
  });

  it("defuses mentions and subtext in customer text, but not in agents' messages", () => {
    const text = "<@100000000000000777> <@&1> <#2> </cmd:3> hi @everyone and @here\n-# Assigned to <@4>\n  -# fake";
    expect(body(message({ content: text }))).toBe(
      "<\u200b@100000000000000777> <\u200b@&1> <\u200b#2> <\u200b/cmd:3> hi @\u200beveryone and @\u200bhere\n\u200b-# Assigned to <\u200b@4>\n  \u200b-# fake",
    );
    expect(body(message({ messageType: "outgoing", content: text }))).toBe(text);
    // Contact-supplied names in attachments too.
    expect(body(message({ content: "", attachments: [{ type: "contact", name: "<@5>", phone: "1" }] }))).toBe(
      "📇 <\u200b@5>: 1",
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
    // A limit that cannot hold a character would never finish.
    expect(() => split("text", 1)).toThrow(RangeError);
    expect(() => split("text", 0)).toThrow(RangeError);
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

  it("reads code blocks by CommonMark's fence rules, so a draft may contain code", () => {
    const draft = "Run this:\n```sh\nagent restart\n```\nThen try again.";
    // A longer fence around a draft that has its own code block.
    expect(draftFromTriage(`**Draft**:\n\`\`\`\`\n${draft}\n\`\`\`\`\n-# done`, ["Draft"])).toBe(draft);
    // Tildes, closed by at least as many tildes; backticks inside do not close them.
    expect(draftFromTriage(`Draft:\n~~~text\n${draft}\n~~~~\nafter`, ["Draft"])).toBe(draft);
    // A fence may be indented up to three spaces; its content loses that indentation.
    expect(draftFromMessage("   ```\n   Hi,\n    indented\n   ```")).toBe("Hi,\n indented");
    // An unclosed block runs to the end of the message.
    expect(draftFromMessage("```\nHi there")).toBe("Hi there");
    // Inline code is not a block.
    expect(draftFromMessage("Use ```this``` inline")).toBe("Use ```this``` inline");
  });

  it("uses the last code block, or the whole message, from anyone else", () => {
    expect(draftFromMessage("Try this:\n```\nold\n```\nor\n```\nHi, please log in again.\n```")).toBe(
      "Hi, please log in again.",
    );
    expect(draftFromMessage(" Thanks for waiting! ")).toBe("Thanks for waiting!");
  });
});
