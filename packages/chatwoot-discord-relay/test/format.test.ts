import { describe, expect, it } from "vitest";
import type { RelayMessage } from "../../../shared/types.ts";
import {
  body,
  CONTENT_LIMIT,
  chatwootMentions,
  postHeader,
  senderName,
  split,
  threadTitle,
  titleSubject,
} from "../src/relay/format.ts";
import { message } from "./helpers.ts";

function title(relayMessage: RelayMessage): string {
  return threadTitle(relayMessage.account.name, relayMessage.conversation, titleSubject(relayMessage));
}

describe("format", () => {
  it("titles name the account, conversation, and customer", () => {
    expect(title(message())).toBe("[Acme #12] Jane Doe — My agent will not connect");
    expect(title(message({ emailSubject: "Billing question" }))).toBe("[Acme #12] Jane Doe — Billing question");
    expect(Array.from(title(message({ content: "x".repeat(500) }))).length).toBeLessThanOrEqual(100);
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
});
