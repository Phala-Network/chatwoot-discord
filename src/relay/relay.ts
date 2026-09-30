// Posts Chatwoot messages into a Discord forum: one post per conversation, opened by a ticket
// header, with every message as a reply under its sender's name. Keeps the post's tags, archived
// flag, and card (its last message, with the ticket's state and buttons) in step with the
// conversation.

import { MessageFlags, type RESTPostAPIWebhookWithTokenJSONBody } from "discord-api-types/v10";
import type { CardTicket } from "../commands/components.ts";
import { errorFields, log } from "../log.ts";
import {
  type Avatars,
  body,
  CONTENT_LIMIT,
  charLength,
  contactName,
  conversationUrl,
  customerAvatar,
  customerName,
  defused,
  postHeader,
  SYSTEM_USERNAME,
  senderAvatar,
  senderName,
  split,
  tagKeys,
  threadTitle,
  titleSubject,
  topicTag,
} from "./format.ts";
import { assignedLine, assigneeKey, Notifier, type TriageOptions } from "./notify.ts";
import type { LinkedAgent, RelayConversation, RelayMessage } from "./types.ts";

export type WebhookMessage = RESTPostAPIWebhookWithTokenJSONBody;
type MessageComponents = NonNullable<WebhookMessage["components"]>;

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
  /** Edits a message the forum's webhook posted; false if the message no longer exists. */
  editMessage(forumChannelId: string, threadId: string, messageId: string, message: WebhookMessage): Promise<boolean>;
  /** Deletes a message the forum's webhook posted; a message that is already gone counts as deleted. */
  deleteMessage(forumChannelId: string, threadId: string, messageId: string): Promise<void>;
  /** True if `threadId` is a post that still exists in the forum. */
  threadExists(forumChannelId: string, threadId: string): Promise<boolean>;
  /** Link to a post, e.g. https://discord.com/channels/<guild>/<thread>. */
  postUrl(forumChannelId: string, threadId: string): Promise<string>;
  /** Adds a user to a post, which must not be archived; adding a member again changes nothing. */
  addMember(threadId: string, userId: string): Promise<void>;
}

/** What is recorded about a conversation's post. */
export interface PostFields {
  threadId: string;
  /** The tags and archived flag last applied to the post (see Relay.stateOf). */
  state: string;
  /** The Chatwoot user id of the assignee the post last announced ("" for none; see assigneeKey). */
  announcedAssignee: string;
  /** 1 while a live message is posted and the assignee is not announced after it yet (see announceAssignee). */
  announcePending: number;
  /**
   * The subject the post's title ends with and the title last applied; unset for a post whose
   * title was not recorded (adopted, or created before titles were recorded).
   */
  titleSubject: string;
  title: string;
  /** The Chatwoot message the title's subject comes from. */
  titleMessageId: number;
  /** The post's card ("" or unset: none yet). */
  cardId: string;
  /** 1 once a message was posted after the card, which then moves to the bottom. */
  cardCovered: number;
  /** The triage bot's answer whose draft the card offers ("" or unset: none). */
  answerId: string;
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
  /** The value recorded for `name` within the retention window, else `decide()`, which is then recorded. */
  once(name: string, decide: () => string): string;
  /** Increments an hourly counter and returns the new value. */
  increment(name: string): number;
}

interface AccountTarget {
  forumChannelId: string;
  /** Shown in post titles. */
  name: string;
  /** The forum's tag ids by what they stand for (see tagKeys). */
  tags: Readonly<Record<string, string>>;
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
  /** The agent linked to a Chatwoot user id, if any. */
  linkedAgent?: ((chatwootUserId: number) => LinkedAgent | undefined) | undefined;
  /** The post's card for the ticket, offering the draft of the triage bot's answer `answerId`; none if unset. */
  card?: ((ticket: CardTicket, answerId: string | undefined) => MessageComponents) | undefined;
  /** Messages created longer ago than this are relayed without notifications. */
  liveSeconds: number;
  now?: () => Date;
}

/** A stored state that matches no conversation: the post's archived flag must be applied again. */
const OUT_OF_DATE = "";
/** Discord applies at most this many tags to a post. */
const MAX_TAGS = 5;
const RELAYED_TYPES = new Set(["incoming", "outgoing", "activity"]);

export class Relay {
  private readonly notifier: Notifier;

  constructor(private readonly options: RelayOptions) {
    this.notifier = new Notifier({
      store: options.store,
      triage: options.triage,
      linkedAgent: options.linkedAgent,
      liveSeconds: options.liveSeconds,
      now: options.now ?? (() => new Date()),
    });
  }

  /**
   * Posts a message into its conversation's post, creating the post if needed. Each Discord
   * message is recorded as soon as it is sent, so a retry resumes after the last one. Templates,
   * deleted and empty messages, and messages from a blocked contact are not relayed. A message
   * that notifies leaves an announcement pending (see `announceAssignee`).
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
    this.unarchived(accountId, conversation);
    if (this.notifier.notifies(message)) store.updateConversation(accountId, conversation.id, { announcePending: 1 });
    // The customer wrote again: the triage bot's last draft answers what came before.
    if (message.messageType === "incoming") store.updateConversation(accountId, conversation.id, { answerId: "" });
  }

  /**
   * The triage bot answered in the post with a draft (its hook reports each answer once it is
   * there): the card offers that draft, under the answer, from the next sync.
   */
  answered(accountId: number, conversationId: number, answerId: string): void {
    const { store } = this.options;
    if (!store.conversation(accountId, conversationId)?.threadId) return;
    store.updateConversation(accountId, conversationId, { answerId, cardCovered: 1 });
  }

  /**
   * After a run's messages, while an announcement is pending: pings a newly assigned, linked
   * agent in a notice of its own, so the ping follows the latest assignment line and names the
   * current assignee however often the conversation was reassigned in between, and adds them to
   * the post. The assignee counts as announced either way. A failed notice stays pending, so the
   * job's retry posts it even when there are no new messages.
   */
  async announceAssignee(accountId: number, conversation: RelayConversation): Promise<void> {
    const discordId = this.notifier.newAssignee(accountId, conversation);
    if (discordId) {
      const notice = this.notice(assignedLine(`<@${discordId}>`));
      const posted = await this.postMessage(accountId, conversation, {
        ...notice,
        allowed_mentions: { parse: [], users: [discordId] },
      });
      if (posted === undefined) return;
      await this.addMember(accountId, conversation.id, discordId);
    }
    this.options.store.updateConversation(accountId, conversation.id, {
      announcedAssignee: assigneeKey(conversation),
      announcePending: 0,
    });
  }

  /**
   * Brings the post's tags, title, archived flag, and card in line with the conversation. The
   * card is the post's last message: it is edited when the conversation changes, and posted again
   * at the bottom (the previous one deleted) once messages were posted after it. Discord only
   * lets a request change an archived post if it also unarchives it, so the changes are applied
   * with `archived: false` and a resolved post is archived by a last request.
   */
  async sync(accountId: number, conversation: RelayConversation, threadId: string): Promise<void> {
    const { store, forum } = this.options;
    const state = this.stateOf(conversation);
    const recorded = store.conversation(accountId, conversation.id);
    const card = this.options.card?.(cardTicket(conversation), recorded?.answerId || undefined);
    const cardDue = card !== undefined && (!recorded?.cardId || recorded.cardCovered === 1);
    if (recorded?.state === state && !cardDue) return;
    const target = this.options.target(accountId);
    const subject = recorded?.titleSubject;
    const title = subject === undefined ? undefined : threadTitle(target.name, conversation, subject);
    // Only a changed title is sent: other updates leave the post's name alone.
    const rename = title !== recorded?.title ? title : undefined;
    try {
      // Only the card is due: the post is as recorded, and not archived unless its ticket is
      // resolved, and then the card is posted anew, which unarchives it.
      if (recorded?.state !== state) {
        await forum.updateThread(target.forumChannelId, threadId, {
          archived: false,
          applied_tags: this.postTags(accountId, conversation),
          ...(rename ? { name: rename } : {}),
        });
        if (rename) store.updateConversation(accountId, conversation.id, { title: rename });
      }
      if (card) await this.placeCard(accountId, conversation.id, threadId, card);
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
   * The message the post's title quotes was deleted in Chatwoot: the title keeps only the ticket
   * and the customer.
   */
  async dropTitleSubject(accountId: number, conversation: RelayConversation, threadId: string): Promise<void> {
    this.options.store.updateConversation(accountId, conversation.id, { titleSubject: "", state: OUT_OF_DATE });
    await this.sync(accountId, conversation, threadId);
  }

  /**
   * Posts a customer's response to an interactive message into the conversation's post, under
   * the contact's name and avatar (see `postMessage`).
   */
  postResponse(accountId: number, conversation: RelayConversation, text: string): Promise<string | undefined> {
    const { frontendUrl, avatars } = this.options;
    let content = defused(text);
    if (content.length > CONTENT_LIMIT) {
      const link = conversationUrl(frontendUrl, accountId, conversation.id);
      const note = `-# Response truncated (${charLength(text)} characters). Full text: <${link}>`;
      content = `${split(content, CONTENT_LIMIT - note.length - 1)[0] ?? ""}\n${note}`;
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
  notify(accountId: number, conversation: RelayConversation, content: string): Promise<string | undefined> {
    return this.postMessage(accountId, conversation, this.notice(content));
  }

  /** The conversation was deleted in Chatwoot: says so in its post, archives it, and forgets it. */
  async closeDeleted(accountId: number, conversationId: number): Promise<void> {
    const { store, forum } = this.options;
    const threadId = store.conversation(accountId, conversationId)?.threadId;
    const gone = this.notice("This conversation no longer exists in Chatwoot.");
    if (threadId && (await this.postMessage(accountId, { id: conversationId }, gone)) !== undefined) {
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
      conversation.assignee?.id ?? "",
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
      store.updateConversation(accountId, conversationId, { cardCovered: 1 });
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
    const tags = this.postTags(accountId, conversation);
    if (tags.length > 0) post.applied_tags = tags;
    const { channelId: threadId } = await forum.execute(target.forumChannelId, post);
    store.updateConversation(accountId, conversation.id, {
      threadId,
      titleSubject: subject,
      title,
      titleMessageId: message.id,
      state: this.stateOf(conversation),
      // Nothing announced yet: an assignee is announced after the run's messages.
      announcedAssignee: "",
    });
    return threadId;
  }

  /**
   * Posts one message into the conversation's post and returns its Discord id; undefined when
   * there is no post, or it no longer exists in Discord (it is then forgotten). Like any message,
   * it unarchives the post: a resolved post needs a sync afterwards.
   */
  private async postMessage(
    accountId: number,
    conversation: Pick<RelayConversation, "id" | "status">,
    message: WebhookMessage,
  ): Promise<string | undefined> {
    const { store, forum } = this.options;
    const threadId = store.conversation(accountId, conversation.id)?.threadId;
    if (!threadId) return undefined;
    let messageId: string;
    try {
      ({ messageId } = await forum.execute(this.forumOf(accountId), message, threadId));
    } catch (error) {
      if (!(error instanceof UnknownThreadError)) throw error;
      store.forgetThread(accountId, conversation.id);
      return undefined;
    }
    this.unarchived(accountId, conversation);
    store.updateConversation(accountId, conversation.id, { cardCovered: 1 });
    return messageId;
  }

  /**
   * Adds a new assignee to the post, right after a message was posted into it (which unarchived
   * it, as Discord requires). Best effort: the announcement is already posted and must not be
   * posted again, so a failure (the user left the server, a missing permission) is only logged.
   */
  private async addMember(accountId: number, conversationId: number, userId: string): Promise<void> {
    const threadId = this.options.store.conversation(accountId, conversationId)?.threadId;
    if (!threadId) return;
    try {
      await this.options.forum.addMember(threadId, userId);
    } catch (error) {
      log.warn("assignee not added to the post", { accountId, conversationId, threadId, ...errorFields(error) });
    }
  }

  /**
   * Edits the post's card, or posts it at the bottom of the post when messages were posted after
   * it (deleting the previous one) or it is gone. The post must not be archived.
   */
  private async placeCard(
    accountId: number,
    conversationId: number,
    threadId: string,
    components: MessageComponents,
  ): Promise<void> {
    const { store, forum, avatars } = this.options;
    const forumChannelId = this.forumOf(accountId);
    const recorded = store.conversation(accountId, conversationId);
    const card: WebhookMessage = { flags: MessageFlags.IsComponentsV2, components };
    const cardId = recorded?.cardId;
    if (cardId && recorded?.cardCovered !== 1) {
      if (await forum.editMessage(forumChannelId, threadId, cardId, card)) return;
    } else if (cardId) {
      await forum.deleteMessage(forumChannelId, threadId, cardId);
    }
    const { messageId } = await forum.execute(
      forumChannelId,
      { ...card, username: SYSTEM_USERNAME, avatar_url: avatars.chatwoot, allowed_mentions: { parse: [] } },
      threadId,
    );
    store.updateConversation(accountId, conversationId, { cardId: messageId, cardCovered: 0 });
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

  /** The configured forum tags the conversation has; what has no tag in the forum is skipped. */
  private postTags(accountId: number, conversation: RelayConversation): string[] {
    const { tags } = this.options.target(accountId);
    const ids = tagKeys(accountId, conversation, this.options.topicAttribute).flatMap((key) => tags[key] ?? []);
    return [...new Set(ids)].slice(0, MAX_TAGS);
  }
}

/** What the post's card shows of the conversation. */
function cardTicket(conversation: RelayConversation): CardTicket {
  const { assignee } = conversation;
  return {
    status: conversation.status ?? "open",
    assignee: assignee ? (assignee.name ?? `#${assignee.id ?? "?"}`) : null,
    labels: conversation.labels,
  };
}
