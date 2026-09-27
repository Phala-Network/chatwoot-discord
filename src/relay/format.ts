// Pure formatting for the Discord side of the relay: titles, sender names, message bodies,
// chunking, and tag names. Nothing here performs I/O.

import type { RelayAttachment, RelayConversation, RelayMessage } from "./types.ts";

export const CONTENT_LIMIT = 2000;
export const TITLE_LIMIT = 100;
const USERNAME_LIMIT = 80;
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
function filled(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text.trim() === "" ? undefined : text;
}

/** Length in code points. */
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
function safeUsername(name: string): string {
  const cleaned = name
    .replace(/discord/gi, (match) => match.replace(/i/i, "1"))
    .replace(/clyde/gi, (match) => match.replace(/l/i, "1"));
  const username = clip(cleaned, USERNAME_LIMIT);
  return username === "" ? SYSTEM_USERNAME : username;
}

export function senderName(message: RelayMessage): string {
  const sender = message.sender ?? {};
  switch (message.messageType) {
    case "activity":
      return SYSTEM_USERNAME;
    case "incoming":
      return customerName(sender);
    default: {
      const fallback = sender.type === "user" ? "Agent" : "Bot";
      return safeUsername(`${filled(sender.name) ?? fallback} · ${message.account.name}`);
    }
  }
}

type Customer = { name?: string | null | undefined; email?: string | null | undefined };

/** A customer's name, else their email. */
export function contactName(customer: Customer): string {
  return filled(customer.name) ?? filled(customer.email) ?? "Customer";
}

/** A customer's name as a webhook username. */
export function customerName(customer: Customer): string {
  return safeUsername(contactName(customer));
}

export interface Avatars {
  /** For everything Chatwoot posts: agent replies, notes, activity lines, cards, and notices. */
  chatwoot: string;
  /** For customers without an https avatar in Chatwoot. */
  contact: string;
}

/** A customer's own https avatar or the contact default; everything else uses the Chatwoot avatar. */
export function senderAvatar(message: RelayMessage, avatars: Avatars): string {
  if (message.messageType !== "incoming") return avatars.chatwoot;
  return customerAvatar(message.sender?.avatarUrl, avatars);
}

/** A customer's own https avatar, else the contact default. */
export function customerAvatar(avatarUrl: string | null | undefined, avatars: Avatars): string {
  const url = filled(avatarUrl);
  return url?.startsWith("https://") ? url : avatars.contact;
}

/** What a post's title says after the customer: the email subject or the first message. */
export function titleSubject(message: RelayMessage): string {
  return clip(filled(message.emailSubject) ?? chatwootMentions(message.content), TITLE_LIMIT);
}

/** `[<Account> #<id>] <customer> — <subject>`, at most 100 characters. */
export function threadTitle(accountName: string, conversation: RelayConversation, subject: string): string {
  const title = `[${accountName} #${conversation.id}] ${contactName(conversation.contact)}`;
  return clip(subject.trim() === "" ? title : `${title} — ${subject}`, TITLE_LIMIT);
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
  const content = chatwootMentions(message.content, message.mentionedAgents).trim();
  const parts: string[] = [];
  if (message.messageType === "activity") {
    if (content) parts.push(`_${content}_`);
  } else {
    if (message.private) parts.push("🔒 **Internal note**");
    if (content) parts.push(content);
  }
  parts.push(...message.attachments.flatMap(attachmentLine));
  return parts.join("\n").trim();
}

function attachmentLine(attachment: RelayAttachment): string[] {
  switch (attachment.type) {
    case "file":
      return filled(attachment.url) ? [`📎 ${attachment.url}`] : [];
    case "contact": {
      const contact = [filled(attachment.name), filled(attachment.phone)].filter(Boolean).join(": ");
      return contact ? [`📇 ${contact}`] : [];
    }
    case "location": {
      const place = [filled(attachment.title), `${attachment.latitude}, ${attachment.longitude}`];
      return [`📍 ${place.filter(Boolean).join(" · ")}${filled(attachment.url) ? ` ${attachment.url}` : ""}`];
    }
  }
}

/** Chatwoot's mention markup (MENTION_REGEX in lib/regex_helper.rb at v4.18.0). */
const MENTION = /\[(@[^\]]+)\]\(mention:\/\/(user|team)\/(\d+)\/[^)]+\)/g;

/**
 * Mentions of users and teams become their `@name`, as in Chatwoot's Slack integration, and
 * mentions of the users in `agents` (Chatwoot user id -> Discord user id) become Discord mentions.
 */
export function chatwootMentions(content: string, agents?: ReadonlyMap<number, string>): string {
  return content.replace(MENTION, (_match, name: string, kind: string, id: string) => {
    const discordId = kind === "user" ? agents?.get(Number(id)) : undefined;
    return discordId ? `<@${discordId}>` : name;
  });
}

/** Ids of the Chatwoot users a message mentions. */
export function mentionedUserIds(content: string): number[] {
  return Array.from(content.matchAll(MENTION), (match) => (match[2] === "user" ? [Number(match[3])] : [])).flat();
}

/**
 * Splits text into chunks of at most `limit` UTF-16 units (never more characters than Discord
 * allows), preferring to cut at a line break.
 */
export function split(input: string, limit = CONTENT_LIMIT): string[] {
  // Two units always fit a character, so every chunk makes progress.
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError(`split limit must be at least 2, not ${limit}`);
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
  return `${frontendUrl.replace(/\/+$/, "")}/app/accounts/${accountId}/conversations/${conversationId}`;
}

/** A customer message: the kind that calls the triage bot and pings the assignee. */
export function fromCustomer(message: RelayMessage): boolean {
  return message.messageType === "incoming" && !message.private;
}

/**
 * Tag for the assignee so the forum can be filtered by owner: the agent's `name`, which is what
 * Chatwoot's dashboard shows as the assignee and in assignment activity messages.
 */
export function assigneeTag(conversation: RelayConversation): string {
  return filled(conversation.assignee?.name) ?? "unassigned";
}

/** Tag for the topic the customer picked (a conversation custom attribute), if any. */
export function topicTag(conversation: RelayConversation, attribute: string): string | undefined {
  return filled(conversation.customAttributes[attribute]);
}

/** The post's tags by name, most important first (Discord applies at most 5). */
export function tagNames(accountTag: string, conversation: RelayConversation, topicAttribute: string) {
  return [
    accountTag,
    conversation.status,
    assigneeTag(conversation),
    topicTag(conversation, topicAttribute),
    filled(conversation.priority),
    ...conversation.labels,
  ];
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
