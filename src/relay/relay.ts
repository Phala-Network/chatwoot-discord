// Posts Chatwoot messages into a Discord forum: one post per conversation, opened by a ticket
// card, with every message as a reply under its sender's name. Keeps the post's tags and
// archived flag in step with the conversation.

import type { RESTPostAPIWebhookWithTokenJSONBody } from "discord-api-types/v10";
import {
  assigneeTag,
  body,
  CONTENT_LIMIT,
  charLength,
  conversationUrl,
  postHeader,
  postState,
  SYSTEM_USERNAME,
  senderAvatar,
  senderName,
  split,
  threadTitle,
  topicTag,
  triageMention,
} from "./format.js";
import type { RelayAssignee, RelayConversation, RelayMessage } from "./types.js";

export type WebhookMessage = RESTPostAPIWebhookWithTokenJSONBody;

/** Thrown by a ForumClient when a post no longer exists in Discord (e.g. it was deleted). */
export class UnknownThreadError extends Error {
  constructor(threadId: string) {
    super(`Discord thread ${threadId} no longer exists`);
    this.name = "UnknownThreadError";
  }
}

export interface ForumClient {
  /** Executes the forum's webhook. Without `threadId`, `message.thread_name` starts a new post. */
  execute(forumChannelId: string, message: WebhookMessage, threadId?: string): Promise<{ channelId: string }>;
  updatePost(threadId: string, patch: { applied_tags: string[]; archived: boolean }): Promise<void>;
  /** Tag ids matched by name, case-insensitively; missing tags are skipped. At most 5. */
  tagIds(forumChannelId: string, names: ReadonlyArray<string | undefined>): Promise<string[]>;
  /** True if `threadId` is a post that still exists in the forum. */
  threadExists(forumChannelId: string, threadId: string): Promise<boolean>;
  /** Link to a post, e.g. https://discord.com/channels/<guild>/<thread>. */
  postUrl(forumChannelId: string, threadId: string): Promise<string>;
}

export interface RelayStore {
  thread(accountId: number, conversationId: number): string | undefined;
  saveThread(accountId: number, conversationId: number, threadId: string): void;
  state(accountId: number, conversationId: number): string | undefined;
  saveState(accountId: number, conversationId: number, state: string): void;
  forgetThread(accountId: number, conversationId: number): void;
  /** True the first time `name` is seen within the retention window. */
  firstAttempt(name: string): boolean;
  /** Increments an hourly counter and returns the new value. */
  increment(name: string): number;
}

export interface AccountTarget {
  forumChannelId: string;
  /** Forum tag for the account (product/brand). */
  tag: string;
}

export interface RelayOptions {
  forum: ForumClient;
  store: RelayStore;
  frontendUrl: string;
  target(accountId: number): AccountTarget;
  topicAttribute: string;
  maxChunks: number;
  triage?: { userId: string; name: string; perConversationPerHour: number; perHour: number };
  /** The Discord user linked to a Chatwoot assignee, if any. */
  discordUserFor?: (assignee: RelayAssignee) => string | undefined;
  /** Called when a post is created, so the conversation can link back to it. */
  linkPost?: (accountId: number, conversationId: number, url: string) => Promise<void>;
  /** Receives errors that are swallowed because they must not stop the relay. */
  onIgnoredError?: (error: unknown) => void;
  now?: () => Date;
}

export type RelayResult = "skipped" | "muted" | "empty" | "relayed";

const RELAYED_TYPES = new Set(["incoming", "outgoing", "activity"]);

export class Relay {
  constructor(private readonly options: RelayOptions) {}

  async relay(message: RelayMessage): Promise<RelayResult> {
    if (!RELAYED_TYPES.has(message.messageType)) return "skipped";
    // A blocked contact's messages are muted in Chatwoot (no notifications); keep them out of Discord too.
    if (message.messageType === "incoming" && message.conversation.contact.blocked) return "muted";

    const text = body(message);
    if (text === "") return "empty";

    const accountId = message.account.id;
    const conversationId = message.conversation.id;
    const username = senderName(message);
    const avatar = senderAvatar(message);
    const assignee = this.assigneePing(message);
    const extra = [this.triageLine(message), assignee && `-# Assigned to <@${assignee}>`].filter(
      (line): line is string => typeof line === "string",
    );
    let chunks = split(text, CONTENT_LIMIT - extra.reduce((sum, line) => sum + line.length + 1, 0));
    if (chunks.length > this.options.maxChunks) {
      chunks = chunks.slice(0, this.options.maxChunks);
      const link = conversationUrl(this.options.frontendUrl, accountId, conversationId);
      chunks.push(`-# Message truncated (${charLength(text)} characters).${link ? ` Full text: <${link}>` : ""}`);
    }
    const messages: WebhookMessage[] = chunks.map((chunk) => ({
      content: chunk,
      username,
      ...(avatar ? { avatar_url: avatar } : {}),
    }));
    const [first] = messages;
    if (first) {
      first.content = [chunks[0], ...extra].join("\n");
      if (assignee) first.allowed_mentions = { parse: [], users: [assignee] };
    }

    const threadId = (await this.postIntoExisting(message, messages)) ?? (await this.createPost(message, messages));
    await this.sync(accountId, message.conversation, threadId, true);
    return "relayed";
  }

  /**
   * Brings the post's tags and archived flag in line with the conversation. Posting into an
   * archived post unarchives it, so after a message (`posted`) a resolved post is archived again.
   */
  async sync(accountId: number, conversation: RelayConversation, threadId: string, posted: boolean): Promise<void> {
    const { store } = this.options;
    const state = this.stateOf(conversation);
    const resolved = postState(conversation) === "resolved";
    if (store.state(accountId, conversation.id) === state && !(resolved && posted)) return;

    await this.options.forum.updatePost(threadId, {
      applied_tags: await this.postTags(accountId, conversation),
      archived: resolved,
    });
    store.saveState(accountId, conversation.id, state);
  }

  /** Posts a notice into the conversation's post when one of its messages could not be relayed. */
  async notifyFailure(accountId: number, conversationId: number, messageId: number): Promise<void> {
    const threadId = this.options.store.thread(accountId, conversationId);
    if (!threadId) return;
    const notice = `⚠️ Chatwoot message ${messageId} could not be relayed. Check it in Chatwoot.`;
    try {
      await this.options.forum.execute(
        this.options.target(accountId).forumChannelId,
        { content: notice, username: SYSTEM_USERNAME, allowed_mentions: { parse: [] } },
        threadId,
      );
    } catch {
      // Best effort: the failure is already logged by the caller.
    }
  }

  stateOf(conversation: RelayConversation): string {
    return `${postState(conversation)}|${assigneeTag(conversation)}|${topicTag(conversation, this.options.topicAttribute) ?? ""}`;
  }

  /** The triage bot mention for a customer message, or a note when its hourly budget is used up. */
  private triageLine(message: RelayMessage): string | undefined {
    const { triage, store } = this.options;
    const mention = triageMention(message, triage?.userId);
    if (!triage || !mention) return undefined;
    // Count each message once: a retry after a failed post must not use up the budget.
    if (!store.firstAttempt(`triage:seen:${message.account.id}:${message.id}`)) return mention;

    const hour = this.now().toISOString().slice(0, 13);
    const key = `${message.account.id}:${message.conversation.id}`;
    if (store.increment(`triage:${key}:${hour}`) > triage.perConversationPerHour) {
      return `-# ${triage.name} not called: more than ${triage.perConversationPerHour} customer messages in this conversation this hour. Ask it here if needed.`;
    }
    if (store.increment(`triage:${hour}`) > triage.perHour) {
      return `-# ${triage.name} not called: more than ${triage.perHour} customer messages this hour. Ask it here if needed.`;
    }
    return mention;
  }

  /**
   * When the conversation gets a new assignee, their Discord id, so the message pings them
   * (which also adds them to the post). Only that user is pinged.
   */
  private assigneePing(message: RelayMessage): string | undefined {
    const { discordUserFor, store } = this.options;
    const assignee = message.conversation.assignee;
    if (!discordUserFor || !assignee?.id) return undefined;
    const stored = store.state(message.account.id, message.conversation.id);
    // A post adopted from a previous relay has no recorded state, so an unchanged assignee cannot
    // be told apart from a new one: do not ping (its tags are still brought up to date).
    if (stored === undefined && store.thread(message.account.id, message.conversation.id)) return undefined;
    if (stored?.split("|")[1] === assigneeTag(message.conversation)) return undefined;
    return discordUserFor(assignee);
  }

  private async postIntoExisting(message: RelayMessage, messages: WebhookMessage[]): Promise<string | undefined> {
    const { store, forum } = this.options;
    const accountId = message.account.id;
    const threadId = store.thread(accountId, message.conversation.id);
    if (!threadId) return undefined;
    try {
      for (const payload of messages) {
        await forum.execute(this.options.target(accountId).forumChannelId, locked(payload), threadId);
      }
      return threadId;
    } catch (error) {
      if (!(error instanceof UnknownThreadError)) throw error;
      store.forgetThread(accountId, message.conversation.id); // The post was deleted in Discord; start a new one.
      return undefined;
    }
  }

  /**
   * The post opens with a ticket card (channel, inbox, customer email, Chatwoot link); the message
   * itself follows as the first reply. Bots act on replies but not on a forum post's opening
   * message, so this lets the first customer message reach a triage bot like any other.
   */
  private async createPost(message: RelayMessage, messages: WebhookMessage[]): Promise<string> {
    const { store, forum } = this.options;
    const accountId = message.account.id;
    const link = conversationUrl(this.options.frontendUrl, accountId, message.conversation.id);
    const card = [postHeader(message), link ? `[Open in Chatwoot](<${link}>)` : ""].filter((line) => line !== "");
    const post: WebhookMessage = {
      thread_name: threadTitle(message),
      content: card.length === 0 ? "New conversation" : card.join("\n"),
      username: SYSTEM_USERNAME,
    };
    const tags = await this.postTags(accountId, message.conversation);
    if (tags.length > 0) post.applied_tags = tags;
    const forumChannelId = this.options.target(accountId).forumChannelId;
    const { channelId: threadId } = await forum.execute(forumChannelId, locked(post));
    store.saveThread(accountId, message.conversation.id, threadId);
    store.saveState(accountId, message.conversation.id, this.stateOf(message.conversation));
    await this.linkPost(accountId, message.conversation.id, forumChannelId, threadId);
    for (const payload of messages) await forum.execute(forumChannelId, locked(payload), threadId);
    return threadId;
  }

  /** The link is a convenience; failing to record it must not stop the relay. */
  private async linkPost(accountId: number, conversationId: number, forumChannelId: string, threadId: string) {
    const { linkPost, forum, onIgnoredError } = this.options;
    if (!linkPost) return;
    try {
      await linkPost(accountId, conversationId, await forum.postUrl(forumChannelId, threadId));
    } catch (error) {
      onIgnoredError?.(error);
    }
  }

  /** Tags: account, open/resolved, assignee, and topic (when set). */
  private postTags(accountId: number, conversation: RelayConversation): Promise<string[]> {
    const target = this.options.target(accountId);
    return this.options.forum.tagIds(target.forumChannelId, [
      target.tag,
      postState(conversation),
      assigneeTag(conversation),
      topicTag(conversation, this.options.topicAttribute),
    ]);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }
}

/** Webhook messages never ping anyone unless a payload explicitly allows a user. */
function locked(message: WebhookMessage): WebhookMessage {
  return { allowed_mentions: { parse: [] }, ...message };
}
