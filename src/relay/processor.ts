// Brings one conversation's forum post up to date from Chatwoot's API: relays every message
// after the stored cursor, in order, then corrects the post's tags and archived flag. Also acts
// on updated messages: removes the Discord messages of a message deleted in Chatwoot and posts
// customers' responses to interactive messages.

import { type Budget, BudgetExhaustedError } from "../budget.js";
import {
  type ChatwootClient,
  type ChatwootConversation,
  MESSAGE_PAGE_SIZE,
  toRelayConversation,
  toRelayMessage,
} from "../chatwoot/api.js";
import type { Settings } from "../config.js";
import { errorFields, log } from "../log.js";
import type { Store } from "../store.js";
import type { ForumClient, Relay } from "./relay.js";
import { interactiveMessage, responseText } from "./response.js";
import type { RelayConversation } from "./types.js";

const INBOX_CACHE_MS = 24 * 60 * 60 * 1000;
/** Requests to bring a post's tags and archived flag up to date: the forum's tags and two updates. */
const SYNC_REQUESTS = 3;

export interface ProcessorContext {
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
  // Worst case for one message: webhook lookup and creation, the forum channel, the card, the
  // conversation link, the chunks, and the truncation note. Room for the final sync is kept too.
  const perMessage = limits.maxChunks + 6 + SYNC_REQUESTS;

  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) {
    log.warn("conversation no longer exists in Chatwoot", { accountId, conversationId });
    await relay.closeDeleted(accountId, conversationId);
    return "done";
  }
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
      const relayMessage = toRelayMessage(message, {
        account: { id: accountId, name: account.name },
        inboxName: inboxName ?? null,
        conversation,
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
        await relay.notifyFailure(accountId, conversationId, message.id);
      }
      cursor = message.id;
      store.setCursor(accountId, conversationId, cursor);
    }
    if (page.length < MESSAGE_PAGE_SIZE) break;
  }

  const threadId = store.thread(accountId, conversationId);
  if (threadId) {
    if (budget.remaining < SYNC_REQUESTS) return "yield";
    await relay.sync(accountId, conversation, threadId);
  }
  return "done";
}

/**
 * Acts on a message reported as updated once Chatwoot's API confirms the change: a deleted
 * message's Discord messages are deleted, and a customer's response to an interactive message
 * is posted. Nothing is done for a conversation without a post.
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
  const text = responseText(interactiveMessage(message.content_type, message.content, message.content_attributes));
  if (text) await postResponse(context, accountId, conversationId, messageId, threadId, text);
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
 * Posts a response once: Chatwoot lets a customer submit again (a CSAT rating can be changed
 * for 14 days), and only a changed response is posted again. Webhook payloads do not say what
 * changed, so other updates of the message (such as its read status) end here and post nothing.
 * A blocked contact's response is not posted, like their messages.
 */
async function postResponse(
  { store, relay, chatwoot }: ProcessorContext,
  accountId: number,
  conversationId: number,
  messageId: number,
  threadId: string,
  text: string,
): Promise<void> {
  const digest = await sha256(text);
  if (store.postedResponse(accountId, conversationId, messageId) === digest) return;
  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) return; // Deleted: the conversation's own job closes the post.
  const conversation = toRelayConversation(conversationId, raw);
  if (conversation.contact.blocked) return;
  if (!(await relay.postResponse(accountId, conversation, threadId, text))) return;
  store.savePostedResponse(accountId, conversationId, messageId, digest);
  log.info("response posted", { accountId, conversationId, messageId });
  const current = store.thread(accountId, conversationId);
  if (current) await relay.sync(accountId, conversation, current);
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

/** The thread id in a https://discord.com/channels/<guild>/<thread> link. */
export function threadIdFromUrl(value: unknown): string | undefined {
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
