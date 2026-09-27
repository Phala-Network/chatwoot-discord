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
  fromCustomer,
  postHeader,
  SYSTEM_USERNAME,
  senderAvatar,
  senderName,
  split,
  threadTitle,
  topicTag,
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
  execute(
    forumChannelId: string,
    message: WebhookMessage,
    threadId?: string,
  ): Promise<{ channelId: string; messageId: string }>;
  /**
   * Modifies a post. Discord rejects changes to an archived post unless the same request
   * unarchives it. Throws UnknownThreadError if the post no longer exists.
   */
  updateThread(threadId: string, patch: { archived: boolean; applied_tags?: string[] }): Promise<void>;
  /** Deletes a message the forum's webhook posted; a message that is already gone counts as deleted. */
  deleteMessage(forumChannelId: string, threadId: string, messageId: string): Promise<void>;
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
  /** The tags and archived flag last applied to the post (see Relay.stateOf). */
  state(accountId: number, conversationId: number): string | undefined;
  saveState(accountId: number, conversationId: number, state: string): void;
  /** The assignee tag the post last announced. */
  announcedAssignee(accountId: number, conversationId: number): string | undefined;
  saveAnnouncedAssignee(accountId: number, conversationId: number, assignee: string): void;
  /** Ids of the Discord messages posted so far for a Chatwoot message, in order. */
  postedParts(accountId: number, conversationId: number, messageId: number): string[];
  savePostedPart(accountId: number, conversationId: number, messageId: number, part: number, discordId: string): void;
  /** Forgets the post and everything recorded about it. */
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

export interface TriageOptions {
  userId: string;
  name: string;
  perConversationPerHour: number;
  perHour: number;
}

export interface RelayOptions {
  forum: ForumClient;
  store: RelayStore;
  frontendUrl: string;
  target(accountId: number): AccountTarget;
  topicAttribute: string;
  maxChunks: number;
  triage?: TriageOptions;
  /** The Discord user linked to a Chatwoot assignee, if any. */
  discordUserFor?: (assignee: RelayAssignee) => string | undefined;
  /** Called when a post is created, so the conversation can link back to it. */
  linkPost?: (accountId: number, conversationId: number, url: string) => Promise<void>;
  /** Receives errors that are swallowed because they must not stop the relay. */
  onIgnoredError?: (error: unknown) => void;
  now?: () => Date;
}

/** A stored state that matches no conversation: the post's archived flag must be applied again. */
const OUT_OF_DATE = "";
const RELAYED_TYPES = new Set(["incoming", "outgoing", "activity"]);
/** The longest user mention (snowflakes have at most 20 digits). */
const LONGEST_MENTION = `<@${"9".repeat(20)}>`;

export class Relay {
  /**
   * Room kept in a message's first part for its notification lines, so a message splits into
   * the same parts on every attempt and a retry can resume after the parts already posted.
   */
  private readonly reserve: number;

  constructor(private readonly options: RelayOptions) {
    const lines = [
      `-# ${LONGEST_MENTION} ${LONGEST_MENTION}`,
      assignedLine(LONGEST_MENTION),
      ...(options.triage ? [conversationBudgetNote(options.triage), hourlyBudgetNote(options.triage)] : []),
    ];
    this.reserve = lines.reduce((sum, line) => sum + line.length + 1, 0);
  }

  /**
   * Posts a message into its conversation's post, creating the post if needed. Each Discord
   * message is recorded as soon as it is sent, so a retry resumes after the last one. Templates,
   * deleted and empty messages, and messages from a blocked contact are not relayed.
   */
  async relay(message: RelayMessage): Promise<void> {
    if (!RELAYED_TYPES.has(message.messageType) || message.deleted) return;
    // A blocked contact's messages are muted in Chatwoot (no notifications); keep them out of Discord too.
    if (message.messageType === "incoming" && message.conversation.contact.blocked) return;
    const text = body(message);
    if (text === "") return;

    const { store } = this.options;
    const accountId = message.account.id;
    const conversation = message.conversation;
    const parts = this.parts(message, text);
    let threadId = store.thread(accountId, conversation.id);
    if (threadId) {
      try {
        await this.post(message, parts, threadId);
      } catch (error) {
        if (!(error instanceof UnknownThreadError)) throw error;
        store.forgetThread(accountId, conversation.id); // The post was deleted in Discord; start a new one.
        threadId = undefined;
      }
    }
    if (!threadId) {
      threadId = await this.createPost(message);
      await this.post(message, parts, threadId);
    }

    const assignee = assigneeTag(conversation);
    if (store.announcedAssignee(accountId, conversation.id) !== assignee) {
      store.saveAnnouncedAssignee(accountId, conversation.id, assignee);
    }
    // Posting into an archived post unarchives it: a resolved post must be archived again.
    if (conversation.status === "resolved") store.saveState(accountId, conversation.id, OUT_OF_DATE);
  }

  /**
   * Brings the post's tags and archived flag in line with the conversation. Discord only lets a
   * request change an archived post's tags if it also unarchives it, so tags are applied with
   * `archived: false` and a resolved post is archived by a second request.
   */
  async sync(accountId: number, conversation: RelayConversation, threadId: string): Promise<void> {
    const { store, forum } = this.options;
    const state = this.stateOf(conversation);
    if (store.state(accountId, conversation.id) === state) return;
    try {
      await forum.updateThread(threadId, {
        archived: false,
        applied_tags: await this.postTags(accountId, conversation),
      });
      if (conversation.status === "resolved") await forum.updateThread(threadId, { archived: true });
    } catch (error) {
      if (!(error instanceof UnknownThreadError)) throw error;
      store.forgetThread(accountId, conversation.id); // Deleted in Discord: the next message starts a new post.
      return;
    }
    store.saveState(accountId, conversation.id, state);
  }

  /** Posts a notice into the conversation's post when one of its messages could not be relayed. */
  async notifyFailure(accountId: number, conversationId: number, messageId: number): Promise<void> {
    const threadId = this.options.store.thread(accountId, conversationId);
    if (!threadId) return;
    try {
      await this.notice(
        accountId,
        threadId,
        `⚠️ Chatwoot message ${messageId} could not be relayed. Check it in Chatwoot.`,
      );
    } catch {
      // Best effort: the failure is already logged by the caller.
    }
  }

  /** The conversation was deleted in Chatwoot: says so in its post, archives it, and forgets it. */
  async closeDeleted(accountId: number, conversationId: number): Promise<void> {
    const { store, forum } = this.options;
    const threadId = store.thread(accountId, conversationId);
    if (!threadId) return;
    try {
      await this.notice(accountId, threadId, "This conversation no longer exists in Chatwoot.");
      await forum.updateThread(threadId, { archived: true });
    } catch (error) {
      if (!(error instanceof UnknownThreadError)) throw error;
    }
    store.forgetThread(accountId, conversationId);
  }

  stateOf(conversation: RelayConversation): string {
    return `${conversation.status ?? ""}|${assigneeTag(conversation)}|${topicTag(conversation, this.options.topicAttribute) ?? ""}`;
  }

  /** The Discord messages for one Chatwoot message; only the first carries notification lines. */
  private parts(message: RelayMessage, text: string): WebhookMessage[] {
    const { frontendUrl, maxChunks } = this.options;
    const announced = this.newAssignee(message);
    const assignee = fromCustomer(message) && !announced ? this.linkedAssignee(message) : undefined;
    const triage = this.triage(message);
    const mentions = [triage.mention, assignee].filter((id) => id !== undefined).map((id) => `<@${id}>`);
    const lines = [
      mentions.length > 0 ? `-# ${mentions.join(" ")}` : undefined,
      triage.note,
      announced ? assignedLine(`<@${announced}>`) : undefined,
    ].filter((line) => line !== undefined);

    let chunks = split(text, CONTENT_LIMIT - this.reserve);
    if (chunks.length > maxChunks) {
      const link = conversationUrl(frontendUrl, message.account.id, message.conversation.id);
      chunks = [
        ...chunks.slice(0, maxChunks),
        `-# Message truncated (${charLength(text)} characters). Full text: <${link}>`,
      ];
    }
    const username = senderName(message);
    const avatar = senderAvatar(message);
    const pinged = announced ?? assignee;
    return chunks.map((chunk, index) => ({
      content: index === 0 ? [chunk, ...lines].join("\n") : chunk,
      username,
      ...(avatar ? { avatar_url: avatar } : {}),
      // Only the notified assignee may be pinged; the triage mention stays a literal token.
      allowed_mentions: index === 0 && pinged ? { parse: [], users: [pinged] } : { parse: [] },
    }));
  }

  /** Posts the parts not yet posted, recording each one. */
  private async post(message: RelayMessage, parts: WebhookMessage[], threadId: string): Promise<void> {
    const { store, forum } = this.options;
    const accountId = message.account.id;
    const conversationId = message.conversation.id;
    const forumChannelId = this.options.target(accountId).forumChannelId;
    for (let part = store.postedParts(accountId, conversationId, message.id).length; part < parts.length; part += 1) {
      const payload = parts[part];
      if (!payload) break;
      const { messageId } = await forum.execute(forumChannelId, payload, threadId);
      store.savePostedPart(accountId, conversationId, message.id, part, messageId);
    }
  }

  /** The triage bot mention for a customer message, or a note when its hourly budget is used up. */
  private triage(message: RelayMessage): { mention?: string; note?: string } {
    const { triage, store } = this.options;
    if (!triage || !fromCustomer(message)) return {};
    // Count each message once: a retry after a failed post must not use up the budget.
    if (!store.firstAttempt(`triage:seen:${message.account.id}:${message.id}`)) return { mention: triage.userId };

    const hour = this.now().toISOString().slice(0, 13);
    const key = `${message.account.id}:${message.conversation.id}`;
    if (store.increment(`triage:${key}:${hour}`) > triage.perConversationPerHour) {
      return { note: conversationBudgetNote(triage) };
    }
    if (store.increment(`triage:${hour}`) > triage.perHour) return { note: hourlyBudgetNote(triage) };
    return { mention: triage.userId };
  }

  /** The linked Discord user of the conversation's assignee, if any. */
  private linkedAssignee(message: RelayMessage): string | undefined {
    const assignee = message.conversation.assignee;
    return assignee?.id ? this.options.discordUserFor?.(assignee) : undefined;
  }

  /**
   * When the conversation has an assignee the post has not announced yet, their Discord id, so
   * the message pings them (which also adds them to the post).
   */
  private newAssignee(message: RelayMessage): string | undefined {
    const { store } = this.options;
    const accountId = message.account.id;
    const conversationId = message.conversation.id;
    // A post adopted from the link attribute has no recorded state, so an unchanged assignee
    // cannot be told apart from a new one: do not ping (its tags are still brought up to date).
    if (store.state(accountId, conversationId) === undefined && store.thread(accountId, conversationId)) {
      return undefined;
    }
    if (store.announcedAssignee(accountId, conversationId) === assigneeTag(message.conversation)) return undefined;
    return this.linkedAssignee(message);
  }

  /**
   * The post opens with a ticket card (channel, inbox, customer email, Chatwoot link); the message
   * itself follows as the first reply. Bots act on replies but not on a forum post's opening
   * message, so this lets the first customer message reach a triage bot like any other.
   */
  private async createPost(message: RelayMessage): Promise<string> {
    const { store, forum, frontendUrl } = this.options;
    const accountId = message.account.id;
    const conversation = message.conversation;
    const link = conversationUrl(frontendUrl, accountId, conversation.id);
    const header = postHeader(message);
    const post: WebhookMessage = {
      thread_name: threadTitle(message),
      content: [header, `[Open in Chatwoot](<${link}>)`].filter((line) => line !== "").join("\n"),
      username: SYSTEM_USERNAME,
      allowed_mentions: { parse: [] },
    };
    const tags = await this.postTags(accountId, conversation);
    if (tags.length > 0) post.applied_tags = tags;
    const forumChannelId = this.options.target(accountId).forumChannelId;
    const { channelId: threadId } = await forum.execute(forumChannelId, post);
    store.saveThread(accountId, conversation.id, threadId);
    store.saveState(accountId, conversation.id, this.stateOf(conversation));
    await this.linkPost(accountId, conversation.id, forumChannelId, threadId);
    return threadId;
  }

  private async notice(accountId: number, threadId: string, content: string): Promise<void> {
    const forumChannelId = this.options.target(accountId).forumChannelId;
    await this.options.forum.execute(
      forumChannelId,
      { content, username: SYSTEM_USERNAME, allowed_mentions: { parse: [] } },
      threadId,
    );
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

  /** Tags: account, status, assignee, and topic (when set). */
  private postTags(accountId: number, conversation: RelayConversation): Promise<string[]> {
    const target = this.options.target(accountId);
    return this.options.forum.tagIds(target.forumChannelId, [
      target.tag,
      conversation.status,
      assigneeTag(conversation),
      topicTag(conversation, this.options.topicAttribute),
    ]);
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }
}

function assignedLine(mention: string): string {
  return `-# Assigned to ${mention}`;
}

function conversationBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perConversationPerHour} customer messages in this conversation this hour. Ask it here if needed.`;
}

function hourlyBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perHour} customer messages this hour. Ask it here if needed.`;
}
