// Acts on messages Chatwoot reports as updated: removes the Discord messages of a message deleted
// in Chatwoot, posts customers' responses to interactive messages, and says when an agent's reply
// could not be delivered.

import { toRelayConversation } from "../chatwoot/api.ts";
import { log } from "../log.ts";
import { clip } from "./format.ts";
import type { ProcessorContext } from "./processor.ts";
import { interactiveMessage, responseText } from "./response.ts";

interface MessageRef {
  accountId: number;
  conversationId: number;
  messageId: number;
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
  const threadId = store.conversation(accountId, conversationId)?.threadId;
  if (!settings.account(accountId) || !threadId) return;
  const message = await chatwoot.getMessage(accountId, conversationId, messageId);
  if (!message) return;
  const ref = { accountId, conversationId, messageId };
  if (message.content_attributes?.deleted === true) {
    await deleteRelayedMessage(context, ref, threadId);
    return;
  }
  if (message.status === "failed" && message.message_type === 1) {
    const reason = message.content_attributes?.external_error?.trim();
    const why = reason ? `: ${clip(reason, 300)}` : ".";
    await postOnce(context, ref, `⚠️ A reply could not be delivered to the customer${why}`, "notice");
    return;
  }
  const text = responseText(interactiveMessage(message.content_type, message.content, message.content_attributes));
  if (text) await postOnce(context, ref, text, "response");
}

async function deleteRelayedMessage(
  { settings, store, forum }: ProcessorContext,
  { accountId, conversationId, messageId }: MessageRef,
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
  { accountId, conversationId, messageId }: MessageRef,
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
      ? await relay.postResponse(accountId, conversation, text)
      : await relay.notify(accountId, conversation, text);
  if (!posted) return;
  store.savePostedResponse(accountId, conversationId, messageId, digest);
  log.info(kind === "response" ? "response posted" : "delivery failure posted", {
    accountId,
    conversationId,
    messageId,
  });
  const threadId = store.conversation(accountId, conversationId)?.threadId;
  if (threadId) await relay.sync(accountId, conversation, threadId);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
