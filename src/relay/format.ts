// Pure formatting for the Discord side of the relay: titles, sender names, message bodies,
// chunking, and tag names. Nothing here performs I/O.

import type { RelayConversation, RelayMessage } from "./types.js";

export const CONTENT_LIMIT = 2000;
export const TITLE_LIMIT = 100;
export const USERNAME_LIMIT = 80;
export const SYSTEM_USERNAME = "Chatwoot";

const CHANNEL_LABELS: Record<string, string> = {
  "Channel::WebWidget": "Live chat",
  "Channel::Email": "Email",
  "Channel::Api": "API",
  "Channel::Whatsapp": "WhatsApp",
  "Channel::Telegram": "Telegram",
  "Channel::Sms": "SMS",
};

/** The value when it has visible content, otherwise undefined. */
export function filled(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text.trim() === "" ? undefined : text;
}

/** Length in code points, which is how Discord and the original relay count characters. */
export function charLength(text: string): number {
  return Array.from(text).length;
}

/** Collapses whitespace and cuts to `limit` characters, ending with an ellipsis when cut. */
export function clip(value: string, limit: number): string {
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

/** Discord rejects webhook usernames containing "discord" or "clyde". */
export function safeUsername(name: string): string {
  const cleaned = name
    .replace(/discord/gi, (match) => match.replace(/i/i, "1"))
    .replace(/clyde/gi, (match) => match.replace(/l/i, "1"));
  const username = clip(cleaned, USERNAME_LIMIT);
  return username === "" ? SYSTEM_USERNAME : username;
}

export function senderName(message: RelayMessage): string {
  const account = filled(message.account.name) ?? "Support";
  const sender = message.sender ?? {};
  switch (message.messageType) {
    case "activity":
      return SYSTEM_USERNAME;
    case "incoming":
      return safeUsername(filled(sender.name) ?? filled(sender.email) ?? "Customer");
    default: {
      const fallback = sender.type === "user" ? "Agent" : "Bot";
      return safeUsername(`${filled(sender.name) ?? fallback} · ${account}`);
    }
  }
}

/** Only https avatars are passed to Discord; activity lines use the webhook's own avatar. */
export function senderAvatar(message: RelayMessage): string | undefined {
  if (message.messageType === "activity") return undefined;
  const url = filled(message.sender?.avatarUrl);
  return url?.startsWith("https://") ? url : undefined;
}

export function threadTitle(message: RelayMessage): string {
  const account = filled(message.account.name) ?? "Support";
  const contact = message.conversation.contact;
  const who = filled(contact.name) ?? filled(contact.email) ?? "Customer";
  const topic = filled(message.emailSubject) ?? message.content;
  const title = `[${account} #${message.conversation.id}] ${who}`;
  return clip(topic.trim() === "" ? title : `${title} — ${topic}`, TITLE_LIMIT);
}

/** Context shown once, at the top of a new post: channel, inbox, and customer email. */
export function postHeader(message: RelayMessage): string {
  const channelType = message.conversation.channel ?? "";
  const channel = filled(CHANNEL_LABELS[channelType] ?? channelType.replace(/^Channel::/, ""));
  const inbox = filled(message.inboxName);
  const email = filled(message.conversation.contact.email);
  const lines: string[] = [];
  if (channel || inbox) lines.push(`-# via ${[channel, inbox].filter(Boolean).join(" · ")}`);
  if (email) lines.push(`-# ${email}`);
  return lines.join("\n");
}

export function body(message: RelayMessage): string {
  const content = message.content.trim();
  const parts: string[] = [];
  if (message.messageType === "activity") {
    if (content) parts.push(`_${content}_`);
  } else {
    if (message.private) parts.push("🔒 **Internal note**");
    if (content) parts.push(content);
  }
  for (const url of message.attachmentUrls) {
    if (filled(url)) parts.push(`📎 ${url}`);
  }
  return parts.join("\n").trim();
}

/**
 * Splits text into chunks of at most `limit` UTF-16 units (never more characters than Discord
 * allows), preferring to cut at a line break.
 */
export function split(input: string, limit = CONTENT_LIMIT): string[] {
  const chunks: string[] = [];
  let text = input;
  while (text.length > limit) {
    let cut = text.lastIndexOf("\n", limit - 1);
    if (cut <= 0) {
      cut = limit;
      // Do not separate a surrogate pair.
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    chunks.push(text.slice(0, cut).trimEnd());
    text = text.slice(cut).replace(/^\n+/, "");
  }
  if (text !== "") chunks.push(text);
  return chunks;
}

export function conversationUrl(frontendUrl: string, accountId: number, conversationId: number): string {
  if (frontendUrl === "") return "";
  return `${frontendUrl.replace(/\/+$/, "")}/app/accounts/${accountId}/conversations/${conversationId}`;
}

/**
 * Only customer messages tag the triage bot. The mention is a literal token that pings nobody,
 * because webhook messages are sent with mentions disabled.
 */
export function triageMention(message: RelayMessage, userId: string | undefined): string | undefined {
  if (!userId || message.messageType !== "incoming") return undefined;
  return `-# <@${userId}>`;
}

/** Chatwoot statuses are open, pending, snoozed, and resolved; the post is either open or resolved. */
export function postState(conversation: RelayConversation): "open" | "resolved" {
  return conversation.status === "resolved" ? "resolved" : "open";
}

/** Tag for the assignee (the agent's name) so the forum can be filtered by owner. */
export function assigneeTag(conversation: RelayConversation): string {
  return filled(conversation.assignee?.name) ?? "unassigned";
}

/** Tag for the topic the customer picked (a conversation custom attribute), if any. */
export function topicTag(conversation: RelayConversation, attribute: string): string | undefined {
  return filled(conversation.customAttributes[attribute]);
}

/** Extracts the draft a triage bot wrote after one of `labels`, e.g. "**Draft**:\n```\n...\n```". */
export function draftFromTriage(content: string, labels: readonly string[]): string | undefined {
  const usable = labels.filter((label) => label !== "").map(escapeRegExp);
  if (usable.length === 0) return undefined;
  const pattern = new RegExp(`(?:${usable.join("|")})[^\\n]*\\n\\s*\`\`\`[^\\n]*\\n(.*?)\`\`\``, "s");
  return pattern.exec(content)?.[1]?.trim();
}

/** The last fenced code block of a message, or the whole message when it has none. */
export function draftFromMessage(content: string): string {
  const blocks = Array.from(content.matchAll(/```[^\n]*\n(.*?)```/gs), (match) => match[1] ?? "");
  return (blocks.at(-1) ?? content).trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
