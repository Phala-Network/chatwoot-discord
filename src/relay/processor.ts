// Brings one conversation's forum post up to date from Chatwoot's API: relays every message
// after the stored cursor, in order, then links the post from the conversation and corrects its
// tags, title, and archived flag. Also acts on updated messages: removes the Discord messages of
// a message deleted in Chatwoot, posts customers' responses to interactive messages, and says
// when an agent's reply could not be delivered.

import { z } from "zod";
import { type Budget, BudgetExhaustedError } from "../budget.ts";
import {
  type ChatwootClient,
  type ChatwootConversation,
  type ChatwootMessage,
  MESSAGE_PAGE_SIZE,
  toRelayConversation,
  toRelayMessage,
} from "../chatwoot/api.ts";
import { relaysInbox, type Settings } from "../config.ts";
import { parseJson } from "../json.ts";
import { errorFields, log } from "../log.ts";
import type { Store } from "../store.ts";
import { clip, mentionedUserIds } from "./format.ts";
import { type ForumClient, Relay, type RelayStore } from "./relay.ts";
import { interactiveMessage, responseText } from "./response.ts";
import type { RelayConversation } from "./types.ts";

const INBOX_CACHE_MS = 24 * 60 * 60 * 1000;
const agentEmailsSchema = z.record(z.string(), z.string());
const AGENTS_CACHE_MS = 60 * 60 * 1000;
/**
 * Worst case for relaying one message besides its parts: the inbox name and the forum's tags
 * for a new post, webhook lookup and creation, the ticket card, the account's agents (for
 * mentions), the truncation note, and a failure notice.
 */
const MESSAGE_REQUESTS = 8;
/** Linking a new post from its conversation: the forum's guild and the attribute update. */
const LINK_REQUESTS = 2;
/** Bringing a post's tags and archived flag up to date: the forum's tags and two updates. */
const SYNC_REQUESTS = 3;

/**
 * Requests one message may need in the worst case, with room left for linking and syncing the
 * post afterwards. A message only starts when this much budget remains.
 */
export function requestsPerMessage(maxChunks: number): number {
  return maxChunks + MESSAGE_REQUESTS + LINK_REQUESTS + SYNC_REQUESTS;
}

/** The relay as configured by `settings`. */
export function relayFor(settings: Settings, forum: ForumClient, store: RelayStore): Relay {
  const triageUserId = settings.config.triage.userId;
  return new Relay({
    forum,
    store,
    frontendUrl: settings.frontendUrl,
    avatars: settings.avatars,
    target: (accountId) => {
      const account = settings.account(accountId);
      if (!account) throw new Error(`Account ${accountId} is not configured`);
      return { forumChannelId: account.forumChannelId, name: account.name, tag: account.tag ?? account.name };
    },
    topicAttribute: settings.config.relay.topicAttribute,
    maxChunks: settings.config.relay.maxChunks,
    triage: triageUserId ? { ...settings.config.triage, userId: triageUserId } : undefined,
    discordUserFor: (assignee) => settings.discordUserForEmail(assignee.email),
    // Normally every message is relayed within the sweep's window (by its webhook, or else by
    // the sweep), so an older one is history: a first sync, or a catch-up after downtime.
    liveSeconds: settings.config.reconcile.lookbackSeconds,
  });
}

interface ProcessorContext {
  settings: Settings;
  store: Store;
  relay: Relay;
  forum: ForumClient;
  chatwoot: ChatwootClient;
  budget: Budget;
}

/** "yield" means the invocation's request budget ran low; run again in a fresh invocation. */
export type ProcessOutcome = "done" | "yield";

export async function processConversation(
  context: ProcessorContext,
  accountId: number,
  conversationId: number,
): Promise<ProcessOutcome> {
  const { settings, store, relay, chatwoot, budget } = context;
  const account = settings.account(accountId);
  if (!account) return "done";
  const limits = settings.config.relay;
  const perMessage = requestsPerMessage(limits.maxChunks);

  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) {
    log.warn("conversation no longer exists in Chatwoot", { accountId, conversationId });
    await relay.closeDeleted(accountId, conversationId);
    return "done";
  }
  if (!relaysInbox(account, raw.inbox_id)) return "done";
  const conversation = toRelayConversation(conversationId, raw);
  if (!store.thread(accountId, conversationId))
    await recoverThread(context, accountId, account.forumChannelId, conversation);

  let cursor = store.conversation(accountId, conversationId)?.cursor;
  if (cursor === undefined && store.thread(accountId, conversationId)) {
    // An adopted post (from the link attribute) already holds the history. With a cutover
    // watermark, continue after it; otherwise start after the latest message.
    if (limits.startAfterMessageId > 0) {
      cursor = limits.startAfterMessageId;
    } else {
      const latest = await chatwoot.listMessages(accountId, conversationId);
      cursor = Math.max(0, ...latest.map((message) => message.id));
    }
    store.setCursor(accountId, conversationId, cursor);
  }
  if (cursor === undefined) {
    // Persist the starting point before posting, so a post created by a failed attempt is not
    // mistaken for an adopted one (whose history would be skipped) on retry.
    cursor = limits.startAfterMessageId;
    store.setCursor(accountId, conversationId, cursor);
  }

  let inboxName: string | null | undefined;
  for (;;) {
    if (budget.remaining < perMessage + 1) return "yield";
    const page = await chatwoot.listMessages(accountId, conversationId, cursor);
    for (const message of page) {
      if (message.id <= cursor) continue;
      if (budget.remaining < perMessage) return "yield";
      if (inboxName === undefined && !store.thread(accountId, conversationId)) {
        inboxName = await cachedInboxName(context, accountId, raw);
      }
      const mentionedAgents = await linkedMentions(context, accountId, message);
      const relayMessage = toRelayMessage(message, {
        account: { id: accountId, name: account.name },
        inboxName: inboxName ?? null,
        conversation,
        ...(mentionedAgents ? { mentionedAgents } : {}),
      });
      try {
        await relay.relay(relayMessage);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) return "yield";
        const attempts = store.recordFailure(accountId, conversationId, message.id);
        if (attempts < limits.maxAttempts) throw error;
        log.error("relay gave up on message", {
          accountId,
          conversationId,
          messageId: message.id,
          attempts,
          ...errorFields(error),
        });
        await notifyQuietly(
          context,
          accountId,
          conversation,
          `⚠️ Chatwoot message ${message.id} could not be relayed. Check it in Chatwoot.`,
        );
      }
      cursor = message.id;
      store.setCursor(accountId, conversationId, cursor);
    }
    if (page.length < MESSAGE_PAGE_SIZE) break;
  }

  const threadId = store.thread(accountId, conversationId);
  if (threadId) {
    if (budget.remaining < LINK_REQUESTS + SYNC_REQUESTS) return "yield";
    await linkPost(context, accountId, account.forumChannelId, conversation, threadId);
    await relay.sync(accountId, conversation, threadId);
  }
  return "done";
}

/**
 * Acts on a message reported as updated once Chatwoot's API confirms the change: a deleted
 * message's Discord messages are deleted, a customer's response to an interactive message is
 * posted, and a notice says when an agent's message could not be delivered. Nothing is done for
 * a conversation without a post.
 */
export async function processMessageUpdate(
  context: ProcessorContext,
  accountId: number,
  conversationId: number,
  messageId: number,
): Promise<void> {
  const { settings, store, chatwoot } = context;
  const threadId = store.thread(accountId, conversationId);
  if (!settings.account(accountId) || !threadId) return;
  const message = await chatwoot.getMessage(accountId, conversationId, messageId);
  if (!message) return;
  if (message.content_attributes?.deleted === true) {
    await deleteRelayedMessage(context, accountId, conversationId, messageId, threadId);
    return;
  }
  if (message.status === "failed" && message.message_type === 1) {
    const reason = message.content_attributes?.external_error?.trim();
    const why = reason ? `: ${clip(reason, 300)}` : ".";
    const notice = `⚠️ A reply could not be delivered to the customer${why}`;
    await postOnce(context, { accountId, conversationId, messageId, threadId }, notice, "notice");
    return;
  }
  const text = responseText(interactiveMessage(message.content_type, message.content, message.content_attributes));
  if (text) await postOnce(context, { accountId, conversationId, messageId, threadId }, text, "response");
}

async function deleteRelayedMessage(
  { settings, store, forum }: ProcessorContext,
  accountId: number,
  conversationId: number,
  messageId: number,
  threadId: string,
): Promise<void> {
  const account = settings.account(accountId);
  const parts = store.postedParts(accountId, conversationId, messageId);
  if (!account || parts.length === 0) return;
  for (const discordId of parts) {
    await forum.deleteMessage(account.forumChannelId, threadId, discordId);
    store.deletePostedPart(accountId, conversationId, messageId, discordId);
  }
  log.info("deleted message removed from post", { accountId, conversationId, messageId, parts: parts.length });
}

/**
 * Posts text about a message once: a customer's response to it (under the customer's name) or
 * a notice. Chatwoot lets a customer submit again (a CSAT rating can be changed for 14 days),
 * and only changed text is posted again. Webhook payloads do not say what changed, so other
 * updates of the message (such as its read status) end here and post nothing. A blocked
 * contact's response is not posted, like their messages.
 */
async function postOnce(
  { store, relay, chatwoot }: ProcessorContext,
  { accountId, conversationId, messageId, threadId }: MessageRef,
  text: string,
  kind: "response" | "notice",
): Promise<void> {
  const digest = await sha256(text);
  if (store.postedResponse(accountId, conversationId, messageId) === digest) return;
  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) return; // Deleted: the conversation's own job closes the post.
  const conversation = toRelayConversation(conversationId, raw);
  if (kind === "response" && conversation.contact.blocked) return;
  const posted =
    kind === "response"
      ? await relay.postResponse(accountId, conversation, threadId, text)
      : await relay.notify(accountId, conversation, text);
  if (!posted) return;
  store.savePostedResponse(accountId, conversationId, messageId, digest);
  log.info(kind === "response" ? "response posted" : "delivery failure posted", {
    accountId,
    conversationId,
    messageId,
  });
  const current = store.thread(accountId, conversationId);
  if (current) await relay.sync(accountId, conversation, current);
}

interface MessageRef {
  accountId: number;
  conversationId: number;
  messageId: number;
  threadId: string;
}

/** A notice that must not fail the job: the failure is already logged by the caller. */
async function notifyQuietly(
  { relay }: ProcessorContext,
  accountId: number,
  conversation: RelayConversation,
  text: string,
): Promise<void> {
  try {
    await relay.notify(accountId, conversation, text);
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Re-adopts a post recorded in the conversation's link attribute when this service has no
 * mapping (e.g. after a cutover or a lost state), as long as the post still exists in the
 * account's forum and is not mapped to another conversation.
 */
async function recoverThread(
  { settings, store, forum }: ProcessorContext,
  accountId: number,
  forumChannelId: string,
  conversation: RelayConversation,
): Promise<void> {
  const attribute = settings.config.relay.linkAttribute;
  if (!attribute) return;
  const threadId = threadIdFromUrl(conversation.customAttributes[attribute]);
  if (!threadId || store.ticketForThread(threadId)) return;
  if (!(await forum.threadExists(forumChannelId, threadId))) return;
  store.adoptThread(accountId, conversation.id, threadId);
  log.info("recovered post from conversation link", { accountId, conversationId: conversation.id, threadId });
}

/**
 * Records the post URL in the conversation's link attribute unless it already points to the
 * post, e.g. after the post was created or recreated. The link is a convenience: failing to
 * record it does not stop the relay, and the next sync tries again.
 */
async function linkPost(
  { settings, chatwoot, forum }: ProcessorContext,
  accountId: number,
  forumChannelId: string,
  conversation: RelayConversation,
  threadId: string,
): Promise<void> {
  const attribute = settings.config.relay.linkAttribute;
  if (!attribute || threadIdFromUrl(conversation.customAttributes[attribute]) === threadId) return;
  try {
    const url = await forum.postUrl(forumChannelId, threadId);
    await chatwoot.setCustomAttribute(accountId, conversation.id, attribute, url);
    conversation.customAttributes[attribute] = url;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
    log.error("could not link post from conversation", {
      accountId,
      conversationId: conversation.id,
      ...errorFields(error),
    });
  }
}

/** The thread id in a https://discord.com/channels/<guild>/<thread> link. */
function threadIdFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d{17,20}\/(\d{17,20})\/?$/.exec(
    value.trim(),
  )?.[1];
}

/** The newest message id Chatwoot included with a conversation, if any. */
export function latestMessageId(conversation: ChatwootConversation): number | undefined {
  const ids = (conversation.messages ?? []).flatMap((message) => (message.id === undefined ? [] : [message.id]));
  return ids.length === 0 ? undefined : Math.max(...ids);
}

/** The inbox name for a new post's ticket card; omitted when Chatwoot will not say. */
async function cachedInboxName(
  { store, chatwoot }: ProcessorContext,
  accountId: number,
  conversation: ChatwootConversation,
): Promise<string | null> {
  const inboxId = conversation.inbox_id;
  if (!inboxId) return null;
  const key = `inbox:${accountId}:${inboxId}`;
  const cached = store.get(key);
  if (cached !== undefined) return cached;
  try {
    const name = await chatwoot.inboxName(accountId, inboxId);
    if (name === undefined) return null;
    store.set(key, name, INBOX_CACHE_MS);
    return name;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
    log.warn("inbox name unavailable", { accountId, inboxId, ...errorFields(error) });
    return null;
  }
}

/**
 * For a private note that mentions Chatwoot users (Chatwoot notifies mentions in notes only:
 * Messages::MentionService at v4.18.0), the linked agents among them by Chatwoot user id.
 */
async function linkedMentions(
  context: ProcessorContext,
  accountId: number,
  message: ChatwootMessage,
): Promise<ReadonlyMap<number, string> | undefined> {
  if (!message.private || !message.content || context.settings.config.agents.length === 0) return undefined;
  const mentioned = mentionedUserIds(message.content);
  if (mentioned.length === 0) return undefined;
  const emails = await cachedAgentEmails(context, accountId);
  const linked = new Map<number, string>();
  for (const userId of mentioned) {
    const discordId = context.settings.discordUserForEmail(emails[String(userId)]);
    if (discordId) linked.set(userId, discordId);
  }
  return linked;
}

/** The account's agents' emails by Chatwoot user id; empty when Chatwoot will not say. */
async function cachedAgentEmails(
  { store, chatwoot }: ProcessorContext,
  accountId: number,
): Promise<Partial<Record<string, string>>> {
  const key = `agents:${accountId}`;
  const cached = agentEmailsSchema.safeParse(parseJson(store.get(key)));
  if (cached.success) return cached.data;
  try {
    const agents = await chatwoot.listAgents(accountId);
    const emails: Record<string, string> = {};
    for (const agent of agents) if (agent.id && agent.email) emails[String(agent.id)] = agent.email;
    store.set(key, JSON.stringify(emails), AGENTS_CACHE_MS);
    return emails;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
    log.warn("agents unavailable for mentions", { accountId, ...errorFields(error) });
    return {};
  }
}
