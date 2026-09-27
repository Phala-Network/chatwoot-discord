// Brings one conversation's forum post up to date from Chatwoot's API: relays every message
// after the stored cursor, in order, then corrects the post's tags and archived flag.

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
import type { RelayConversation } from "./types.js";

const INBOX_CACHE_MS = 24 * 60 * 60 * 1000;

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
  // conversation link, the chunks, the truncation note, and a tag update.
  const perMessage = limits.maxChunks + 9;

  const raw = await chatwoot.getConversation(accountId, conversationId);
  const conversation = toRelayConversation(raw);
  if (!store.thread(accountId, conversationId))
    await recoverThread(context, accountId, account.forumChannelId, conversation);

  let cursor = store.conversation(accountId, conversationId)?.cursor;
  if (cursor === undefined && store.thread(accountId, conversationId)) {
    // A post created by a previous relay (adopted from the link attribute) already holds the history. With a
    // cutover watermark, continue after it; otherwise start after the latest message.
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
    if (budget.remaining < 3) return "yield";
    await relay.sync(accountId, conversation, threadId, false);
  }
  return "done";
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
  const ids = (conversation.messages ?? []).map((message) => message.id);
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
    store.set(key, name, INBOX_CACHE_MS);
    return name;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
    log.warn("inbox name unavailable", { accountId, inboxId, ...errorFields(error) });
    return null;
  }
}
