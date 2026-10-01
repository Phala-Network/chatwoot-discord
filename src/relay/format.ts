// Pure formatting for the Discord side of the relay: titles, sender names, message bodies,
// chunking, and tag names. Nothing here performs I/O.

import type { RelayAttachment, RelayConversation, RelayItem, RelayMessage } from "./types.ts";

export const CONTENT_LIMIT = 2000;
export const TITLE_LIMIT = 100;
const USERNAME_LIMIT = 80;
export const SYSTEM_USERNAME = "Chatwoot";

/** Chatwoot's channel classes (app/models/channel/ at v4.18.0). */
const CHANNEL_LABELS: Record<string, string> = {
  "Channel::Api": "API",
  "Channel::Email": "Email",
  "Channel::FacebookPage": "Facebook",
  "Channel::Instagram": "Instagram",
  "Channel::Line": "LINE",
  "Channel::Sms": "SMS",
  "Channel::Telegram": "Telegram",
  "Channel::Tiktok": "TikTok",
  "Channel::TwilioSms": "Twilio",
  "Channel::TwitterProfile": "Twitter",
  "Channel::WebWidget": "Live chat",
  "Channel::Whatsapp": "WhatsApp",
};

/** Channels that reach the contact by phone number, which the ticket header then shows. */
const PHONE_CHANNELS: ReadonlySet<string> = new Set(["Channel::Sms", "Channel::TwilioSms", "Channel::Whatsapp"]);

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
  /** For everything Chatwoot posts: activity lines, cards, notices, and agent bots without an avatar. */
  chatwoot: string;
  /** For customers without an https avatar in Chatwoot. */
  contact: string;
}

/**
 * A customer's own https avatar or the contact default. An agent's message shows the linked
 * agent's Discord avatar, else the agent's own https avatar in Chatwoot; an agent bot's, its https
 * avatar in Chatwoot (its own, else its inbox's). Everything else uses the Chatwoot avatar.
 */
export function senderAvatar(message: RelayMessage, avatars: Avatars): string {
  if (message.messageType === "incoming") return customerAvatar(message.sender?.avatarUrl, avatars);
  if (message.messageType === "outgoing") {
    // An agent's Discord avatar, else their Chatwoot one; an agent bot's own (or its inbox's).
    const discord = message.sender?.type === "user" ? message.discordAvatarUrl : undefined;
    return discord ?? httpsUrl(message.sender?.avatarUrl) ?? avatars.chatwoot;
  }
  return avatars.chatwoot;
}

/** A customer's own https avatar, else the contact default. */
export function customerAvatar(avatarUrl: string | null | undefined, avatars: Avatars): string {
  return httpsUrl(avatarUrl) ?? avatars.contact;
}

function httpsUrl(url: string | null | undefined): string | undefined {
  return url?.startsWith("https://") ? url : undefined;
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

/**
 * Context shown once, at the top of a new post: channel, inbox, and the customer's email, and
 * their phone number on channels that reach them by phone.
 */
export function postHeader(message: RelayMessage): string {
  const channel = channelName(message.conversation);
  const inbox = filled(message.inboxName);
  const lines: string[] = [];
  if (channel || inbox) lines.push(`-# via ${[channel, inbox].filter(Boolean).join(" · ")}`);
  for (const detail of contactDetails(message.conversation)) lines.push(`-# ${detail}`);
  return lines.join("\n");
}

/** The conversation's channel, as people call it. */
export function channelName(conversation: Pick<RelayConversation, "channel">): string | undefined {
  const type = conversation.channel;
  return filled(CHANNEL_LABELS[type ?? ""] ?? type?.replace(/^Channel::/, ""));
}

/** How to reach the contact: their email, and their phone number on phone channels. */
export function contactDetails(conversation: Pick<RelayConversation, "channel" | "contact">): string[] {
  const { channel, contact } = conversation;
  const phone = PHONE_CHANNELS.has(channel ?? "") ? filled(contact.phone) : undefined;
  return [filled(contact.email), phone].filter((detail) => detail !== undefined);
}

export function body(message: RelayMessage): string {
  const content = markdownImages(chatwootMentions(message.content, message.mentionedAgents)).trim();
  const parts: string[] = [];
  if (message.messageType === "activity") {
    if (content) parts.push(`_${content}_`);
  } else {
    if (message.private) parts.push("🔒 **Internal note**");
    if (content) parts.push(content);
  }
  parts.push(...(message.items ?? []).map(itemLine));
  parts.push(...message.attachments.flatMap(attachmentLine));
  const text = parts.join("\n").trim();
  return message.messageType === "incoming" ? defused(text) : text;
}

/**
 * Customer text that cannot call anyone or pass for the relay's own lines: a zero-width space
 * after the `<` of a user, role, channel, or command mention (`<@…>`, `<@&…>`, `<#…>`, `</…>`),
 * after the `@` of `@everyone` and `@here`, and before a `-#` (Discord's subtext) that starts a
 * line. `allowed_mentions` already keeps them from pinging anyone; this also keeps bots that read
 * the text, such as the triage bot, from acting on them.
 */
export function defused(text: string): string {
  return text
    .replace(/<(?=[@#/])/g, "<\u200b")
    .replace(/@(?=everyone|here)/g, "@\u200b")
    .replace(/^([ \t]*)-#/gm, "$1\u200b-#");
}

/**
 * Markdown images, which Discord's markdown has no syntax for, as their URL, which Discord
 * previews: e.g. a LINE sticker, which Chatwoot stores as `![sticker-<id>](<url>)`
 * (Line::IncomingMessageService at v4.18.0).
 */
function markdownImages(content: string): string {
  return content.replace(/!\[[^\]\n]*\]\((https?:\/\/[^)\s]+)\)/g, "$1");
}

/** A bot's option, card, or article: its title (linked when it has a URL), description, and buttons. */
function itemLine(item: RelayItem): string {
  const title = filled(item.title) ?? item.url;
  const heading = filled(item.url) && title !== item.url ? `[${title}](<${item.url}>)` : title;
  const description = filled(item.description) ? ` — ${item.description}` : "";
  const links = item.links.map((link) => ` · [${filled(link.text) ?? link.url}](<${link.url}>)`).join("");
  return `• ${heading}${description}${links}`;
}

function attachmentLine(attachment: RelayAttachment): string[] {
  switch (attachment.type) {
    case "file": {
      const line = [filled(attachment.label), filled(attachment.url)].filter(Boolean).join(" ");
      return line ? [`📎 ${line}`] : [];
    }
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

/** Tag for the topic the customer picked (a conversation custom attribute), if any. */
export function topicTag(conversation: RelayConversation, attribute: string): string | undefined {
  return filled(conversation.customAttributes[attribute]);
}

/**
 * What the post's tags stand for, as `forumTags` keys, most important first (Discord applies at
 * most 5): account, status, assignee (Chatwoot user id), topic, priority, then labels.
 */
export function tagKeys(accountId: number, conversation: RelayConversation, topicAttribute: string): string[] {
  const { assignee } = conversation;
  const topic = topicTag(conversation, topicAttribute);
  const priority = filled(conversation.priority);
  return [
    `account:${accountId}`,
    ...(conversation.status ? [`status:${conversation.status}`] : []),
    ...(assignee ? (assignee.id ? [`assignee:${assignee.id}`] : []) : ["assignee:none"]),
    ...(topic ? [`topic:${topic}`] : []),
    ...(priority ? [`priority:${priority}`] : []),
    ...conversation.labels.map((label) => `label:${label}`),
  ];
}

/** The last fenced code block of a message, if it has one. */
export function lastCodeBlock(content: string): string | undefined {
  return codeBlocks(content.split("\n")).at(-1)?.trim();
}

/** The last fenced code block of a message, or the whole message when it has none. */
export function draftFromMessage(content: string): string {
  return lastCodeBlock(content) ?? content.trim();
}

/**
 * The text of fenced code blocks, by CommonMark's rules (spec 0.31, "Fenced code
 * blocks"): a fence of at least three backticks or tildes, indented at most three spaces, opens a
 * block (a backtick fence's info string has no backticks); a fence of the same character, at
 * least as long, alone on its line, closes it; an unclosed block runs to the end.
 */
function codeBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const open = /^( {0,3})(`{3,}(?!.*`)|~{3,})/.exec(lines[line] ?? "");
    if (!open) continue;
    const [, indent = "", fence = ""] = open;
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
    let end = line + 1;
    while (end < lines.length && !close.test(lines[end] ?? "")) end += 1;
    // Content lines lose as much indentation as the opening fence had.
    const unindent = new RegExp(`^ {0,${indent.length}}`);
    const text = lines.slice(line + 1, end).map((row) => row.replace(unindent, ""));
    blocks.push(text.join("\n"));
    line = end;
  }
  return blocks;
}
