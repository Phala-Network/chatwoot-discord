// Posts Chatwoot messages into a Discord forum: one post per conversation, opened by a ticket
// card, with every message as a reply under its sender's name. Keeps the post's tags and
// archived flag in step with the conversation.

import type { RESTPostAPIWebhookWithTokenJSONBody } from "discord-api-types/v10";
import {
  type Avatars,
  assigneeTag,
  body,
  CONTENT_LIMIT,
  charLength,
  contactName,
  conversationUrl,
  customerAvatar,
  customerName,
  postHeader,
  SYSTEM_USERNAME,
  senderAvatar,
  senderName,
  split,
  tagNames,
  threadTitle,
  titleSubject,
  topicTag,
} from "./format.ts";
import { Notifier, type TriageOptions } from "./notify.ts";
import type { RelayAssignee, RelayConversation, RelayMessage } from "./types.ts";

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
   * Modifies a post of the forum. Discord rejects changes to an archived post unless the same
   * request unarchives it. Throws UnknownThreadError if the post no longer exists.
   */
  updateThread(
    forumChannelId: string,
    threadId: string,
    patch: { archived: boolean; applied_tags?: string[]; name?: string },
  ): Promise<void>;
  /** Deletes a message the forum's webhook posted; a message that is already gone counts as deleted. */
  deleteMessage(forumChannelId: string, threadId: string, messageId: string): Promise<void>;
  /** Tag ids matched by name, case-insensitively; missing tags are skipped. At most 5. */
  tagIds(forumChannelId: string, names: ReadonlyArray<string | undefined>): Promise<string[]>;
  /** True if `threadId` is a post that still exists in the forum. */
  threadExists(forumChannelId: string, threadId: string): Promise<boolean>;
  /** Link to a post, e.g. https://discord.com/channels/<guild>/<thread>. */
  postUrl(forumChannelId: string, threadId: string): Promise<string>;
}

/** What is recorded about a conversation's post. */
export interface PostFields {
  threadId: string;
  /** The tags and archived flag last applied to the post (see Relay.stateOf). */
  state: string;
  /** The assignee tag the post last announced. */
  announcedAssignee: string;
  /**
   * The subject the post's title ends with and the title last applied; unset for a post whose
   * title this service did not record (adopted, or created by an earlier version).
   */
  titleSubject: string;
  title: string;
}

export interface RelayStore {
  /** What is recorded about the conversation's post; a field is undefined until it is set. */
  conversation(
    accountId: number,
    conversationId: number,
  ): { [Field in keyof PostFields]: PostFields[Field] | undefined } | undefined;
  /** Records the given fields. */
  updateConversation(accountId: number, conversationId: number, patch: Partial<PostFields>): void;
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

interface AccountTarget {
  forumChannelId: string;
  /** Shown in post titles. */
  name: string;
  /** Forum tag for the account (product/brand). */
  tag: string;
}

export interface RelayOptions {
  forum: ForumClient;
  store: RelayStore;
  frontendUrl: string;
  avatars: Avatars;
  target(accountId: number): AccountTarget;
  topicAttribute: string;
  maxChunks: number;
  triage?: TriageOptions | undefined;
  /** The Discord user linked to a Chatwoot assignee, if any. */
  discordUserFor?: ((assignee: RelayAssignee) => string | undefined) | undefined;
  /** Messages created longer ago than this are relayed without notifications. */
  liveSeconds: number;
  now?: () => Date;
}

/** A stored state that matches no conversation: the post's archived flag must be applied again. */
const OUT_OF_DATE = "";
const RELAYED_TYPES = new Set(["incoming", "outgoing", "activity"]);

export class Relay {
  private readonly notifier: Notifier;

  constructor(private readonly options: RelayOptions) {
    this.notifier = new Notifier({
      store: options.store,
      triage: options.triage,
      discordUserFor: options.discordUserFor,
      liveSeconds: options.liveSeconds,
      now: options.now ?? (() => new Date()),
    });
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
    let threadId = store.conversation(accountId, conversation.id)?.threadId;
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
    this.notifier.posted(message);
    this.unarchived(accountId, conversation);
  }

  /**
   * Brings the post's tags, title, and archived flag in line with the conversation. Discord only
   * lets a request change an archived post if it also unarchives it, so the changes are applied
   * with `archived: false` and a resolved post is archived by a second request.
   */
  async sync(accountId: number, conversation: RelayConversation, threadId: string): Promise<void> {
    const { store, forum } = this.options;
    const state = this.stateOf(conversation);
    const recorded = store.conversation(accountId, conversation.id);
    if (recorded?.state === state) return;
    const target = this.options.target(accountId);
    const subject = recorded?.titleSubject;
    const title = subject === undefined ? undefined : threadTitle(target.name, conversation, subject);
    // Only a changed title is sent: other updates leave the post's name alone.
    const rename = title !== recorded?.title ? title : undefined;
    try {
      await forum.updateThread(target.forumChannelId, threadId, {
        archived: false,
        applied_tags: await this.postTags(accountId, conversation),
        ...(rename ? { name: rename } : {}),
      });
      if (rename) store.updateConversation(accountId, conversation.id, { title: rename });
      if (conversation.status === "resolved") {
        await forum.updateThread(target.forumChannelId, threadId, { archived: true });
      }
    } catch (error) {
      if (!(error instanceof UnknownThreadError)) throw error;
      store.forgetThread(accountId, conversation.id); // Deleted in Discord: the next message starts a new post.
      return;
    }
    store.updateConversation(accountId, conversation.id, { state });
  }

  /**
   * Posts a customer's response to an interactive message into the conversation's post, under
   * the contact's name and avatar (see `postMessage`).
   */
  postResponse(accountId: number, conversation: RelayConversation, text: string): Promise<boolean> {
    const { frontendUrl, avatars } = this.options;
    let content = text;
    if (content.length > CONTENT_LIMIT) {
      const link = conversationUrl(frontendUrl, accountId, conversation.id);
      const note = `-# Response truncated (${charLength(text)} characters). Full text: <${link}>`;
      content = `${split(text, CONTENT_LIMIT - note.length - 1)[0] ?? ""}\n${note}`;
    }
    return this.postMessage(accountId, conversation, {
      content,
      username: customerName(conversation.contact),
      avatar_url: customerAvatar(conversation.contact.avatarUrl, avatars),
      allowed_mentions: { parse: [] },
    });
  }

  /**
   * Posts a notice into the conversation's post, e.g. when one of its messages could not be
   * relayed or delivered (see `postMessage`).
   */
  notify(accountId: number, conversation: RelayConversation, content: string): Promise<boolean> {
    return this.postMessage(accountId, conversation, this.notice(content));
  }

  /** The conversation was deleted in Chatwoot: says so in its post, archives it, and forgets it. */
  async closeDeleted(accountId: number, conversationId: number): Promise<void> {
    const { store, forum } = this.options;
    const threadId = store.conversation(accountId, conversationId)?.threadId;
    const gone = this.notice("This conversation no longer exists in Chatwoot.");
    if (threadId && (await this.postMessage(accountId, { id: conversationId }, gone))) {
      try {
        await forum.updateThread(this.forumOf(accountId), threadId, { archived: true });
      } catch (error) {
        if (!(error instanceof UnknownThreadError)) throw error;
      }
    }
    store.forgetThread(accountId, conversationId);
  }

  /** What the post shows of the conversation: a post is synced when this changes. */
  stateOf(conversation: RelayConversation): string {
    return JSON.stringify([
      conversation.status ?? "",
      assigneeTag(conversation),
      topicTag(conversation, this.options.topicAttribute) ?? "",
      conversation.priority ?? "",
      conversation.labels.toSorted(),
      contactName(conversation.contact),
    ]);
  }

  /**
   * The Discord messages for one Chatwoot message. The notification lines go on the last part
   * (before a truncation note), so a bot they call sees the whole message. Every part is split
   * with room for them, so a message splits the same way on every attempt and a retry can
   * resume after the parts already posted.
   */
  private parts(message: RelayMessage, text: string): WebhookMessage[] {
    const { frontendUrl, maxChunks } = this.options;
    const notification = this.notifier.notification(message);
    const chunks = split(text, CONTENT_LIMIT - this.notifier.reserve);
    const kept = chunks.slice(0, maxChunks);
    const username = senderName(message);
    const avatar = senderAvatar(message, this.options.avatars);
    const agents = [...(message.mentionedAgents?.values() ?? [])];
    const parts: WebhookMessage[] = kept.map((chunk, index) => {
      const last = index === kept.length - 1;
      const content = last ? [chunk, ...notification.lines].join("\n") : chunk;
      // Linked agents mentioned in a private note are pinged where the mention is.
      const users = new Set([
        ...(last ? notification.users : []),
        ...agents.filter((id) => chunk.includes(`<@${id}>`)),
      ]);
      return {
        content,
        username,
        avatar_url: avatar,
        allowed_mentions: users.size > 0 ? { parse: [], users: [...users] } : { parse: [] },
      };
    });
    if (chunks.length > maxChunks) {
      const link = conversationUrl(frontendUrl, message.account.id, message.conversation.id);
      parts.push({
        content: `-# Message truncated (${charLength(text)} characters). Full text: <${link}>`,
        username,
        avatar_url: avatar,
        allowed_mentions: { parse: [] },
      });
    }
    return parts;
  }

  /** Posts the parts not yet posted, recording each one. */
  private async post(message: RelayMessage, parts: WebhookMessage[], threadId: string): Promise<void> {
    const { store, forum } = this.options;
    const accountId = message.account.id;
    const conversationId = message.conversation.id;
    const forumChannelId = this.forumOf(accountId);
    for (let part = store.postedParts(accountId, conversationId, message.id).length; part < parts.length; part += 1) {
      const payload = parts[part];
      if (!payload) break;
      const { messageId } = await forum.execute(forumChannelId, payload, threadId);
      store.savePostedPart(accountId, conversationId, message.id, part, messageId);
    }
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
    const target = this.options.target(accountId);
    const link = conversationUrl(frontendUrl, accountId, conversation.id);
    const header = postHeader(message);
    const subject = titleSubject(message);
    const title = threadTitle(target.name, conversation, subject);
    const post: WebhookMessage = {
      thread_name: title,
      content: [header, `[Open in Chatwoot](<${link}>)`].filter((line) => line !== "").join("\n"),
      username: SYSTEM_USERNAME,
      avatar_url: this.options.avatars.chatwoot,
      allowed_mentions: { parse: [] },
    };
    const tags = await this.postTags(accountId, conversation);
    if (tags.length > 0) post.applied_tags = tags;
    const { channelId: threadId } = await forum.execute(target.forumChannelId, post);
    store.updateConversation(accountId, conversation.id, {
      threadId,
      titleSubject: subject,
      title,
      state: this.stateOf(conversation),
    });
    return threadId;
  }

  /**
   * Posts one message into the conversation's post. Returns false when there is no post, or it
   * no longer exists in Discord (it is then forgotten). Like any message, it unarchives the post:
   * a resolved post needs a sync afterwards.
   */
  private async postMessage(
    accountId: number,
    conversation: Pick<RelayConversation, "id" | "status">,
    message: WebhookMessage,
  ): Promise<boolean> {
    const { store, forum } = this.options;
    const threadId = store.conversation(accountId, conversation.id)?.threadId;
    if (!threadId) return false;
    try {
      await forum.execute(this.forumOf(accountId), message, threadId);
    } catch (error) {
      if (!(error instanceof UnknownThreadError)) throw error;
      store.forgetThread(accountId, conversation.id);
      return false;
    }
    this.unarchived(accountId, conversation);
    return true;
  }

  /** A message from Chatwoot itself. */
  private notice(content: string): WebhookMessage {
    return {
      content,
      username: SYSTEM_USERNAME,
      avatar_url: this.options.avatars.chatwoot,
      allowed_mentions: { parse: [] },
    };
  }

  private forumOf(accountId: number): string {
    return this.options.target(accountId).forumChannelId;
  }

  /** Posting into an archived post unarchives it: a resolved post must be archived again. */
  private unarchived(accountId: number, conversation: Pick<RelayConversation, "id" | "status">): void {
    if (conversation.status === "resolved") {
      this.options.store.updateConversation(accountId, conversation.id, { state: OUT_OF_DATE });
    }
  }

  private postTags(accountId: number, conversation: RelayConversation): Promise<string[]> {
    const target = this.options.target(accountId);
    return this.options.forum.tagIds(
      target.forumChannelId,
      tagNames(target.tag, conversation, this.options.topicAttribute),
    );
  }
}
