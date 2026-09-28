// Chatwoot REST API (v4.18.0), called only through routes listed in its published OpenAPI spec.
// Requests and most responses are typed by the generated schema (src/chatwoot/schema.d.ts).
// Messages are validated with zod instead, because the spec's `message` schema does not match
// what the API returns for the fields the relay reads (see messageSchema).

import createClient from "openapi-fetch";
import { z } from "zod";
import type { MessageType, RelayAttachment, RelayConversation, RelayItem, RelayMessage } from "../relay/types.ts";
import type { components, operations, paths } from "./schema.ts";

export type Fetch = (input: Request) => Promise<Response>;

/** A non-2xx answer from Chatwoot. Only the status is kept: bodies may echo user content. */
export class ChatwootError extends Error {
  readonly status: number;

  constructor(status: number, operation: string) {
    super(`Chatwoot ${operation} failed with HTTP ${status}`);
    this.name = "ChatwootError";
    this.status = status;
  }
}

/**
 * A conversation as returned by GET conversations/{id} and in the conversation list. The spec's
 * `status` enum omits `snoozed`, which the API does return, so the relay treats it as a string.
 */
export type ChatwootConversation = components["schemas"]["conversation_show"];

const text = z.string().nullish();

/**
 * An attachment as Attachment#push_event_data returns it (app/models/attachment.rb at v4.18.0):
 * files have a `data_url`; a shared location has coordinates, a `fallback_title` (the place),
 * and maybe a `data_url`; a `fallback` (content a channel could not deliver as a file) has a
 * `fallback_title` and maybe a `data_url`; a shared contact has its phone number as
 * `fallback_title` and its name in `meta`, as `firstName`/`lastName` from WhatsApp
 * (Whatsapp::IncomingContactMessageHandler) or `first_name`/`last_name` from Telegram
 * (Telegram::IncomingMessageService#attach_contact).
 */
const attachmentSchema = z.object({
  file_type: text,
  data_url: text,
  fallback_title: text,
  coordinates_lat: z.number().nullish(),
  coordinates_long: z.number().nullish(),
  meta: z.object({ firstName: text, lastName: text, first_name: text, last_name: text }).nullish().catch(null),
});

/**
 * An item of a bot's `input_select`, `cards`, or `article` message (`content_attributes.items`,
 * with the keys ContentAttributeValidator allows at v4.18.0).
 */
const itemText = text.catch(null);
const itemSchema = z.object({
  title: itemText,
  value: itemText,
  description: itemText,
  media_url: itemText,
  link: itemText,
  actions: z
    .array(z.object({ text: itemText, uri: itemText }))
    .nullish()
    .catch(null),
});
const ITEM_CONTENT_TYPES: ReadonlySet<string> = new Set(["input_select", "cards", "article"]);

/** Attachments shown as a link with a label: Instagram story mentions and reels. */
const LINK_LABELS: Partial<Record<string, string>> = { story_mention: "Story mention", ig_reel: "Reel" };

/**
 * The spec's `message` schema describes a single `attachment` object and leaves `sender` and
 * `content_attributes` untyped, while the API returns `attachments[]` (app/views/api/v1/models/
 * _message.json.jbuilder), a sender with `id`/`name`/`email`/`type`/`thumbnail`, and content
 * attributes such as `email` (see emailSchema), `deleted`, `external_error` (why a failed message
 * was not delivered), and the response to an interactive message (`submitted_values`,
 * `submitted_email`, `items`; app/models/message.rb). Only those fields are read; the shape of a
 * response is checked where it is formatted (relay/response.ts).
 */
/**
 * An email message's `content_attributes.email`, MailPresenter#serialized_data at v4.18.0: the
 * subject, whether it is an automatic reply (`auto_reply`), and the text and HTML bodies. Each
 * body's `quoted` is the reply without the quoted history (EmailReplyTrimmer; the HTML one
 * already converted to text by HtmlParser), while the message's `content` is the whole text.
 */
const emailSchema = z.object({
  subject: text,
  auto_reply: z.boolean().nullish(),
  text_content: z.object({ quoted: text }).nullish().catch(null),
  html_content: z.object({ quoted: text }).nullish().catch(null),
});

const messageSchema = z.object({
  id: z.number(),
  content: text,
  message_type: z.number(),
  content_type: text,
  /** sent, delivered, read, or failed. */
  status: text,
  /** Unix seconds. */
  created_at: z.number().nullish(),
  private: z.boolean().nullish(),
  content_attributes: z
    .object({
      email: emailSchema.nullish(),
      deleted: z.boolean().nullish(),
      external_error: text,
      submitted_values: z.unknown().optional(),
      submitted_email: z.unknown().optional(),
      items: z.unknown().optional(),
    })
    .nullish()
    .catch(null),
  sender: z.object({ id: z.number().nullish(), name: text, email: text, type: text, thumbnail: text }).nullish(),
  attachments: z.array(attachmentSchema).nullish(),
});
export type ChatwootMessage = z.infer<typeof messageSchema>;
const messageListSchema = z.object({ payload: z.array(messageSchema) });

/** Chatwoot returns up to 100 messages per `after` page. */
export const MESSAGE_PAGE_SIZE = 100;

type MultipartMessage =
  operations["create-a-new-message-in-a-conversation"]["requestBody"]["content"]["multipart/form-data"];

/** The body of POST conversations/{id}/toggle_status. */
export type StatusChange = operations["toggle-status-of-a-conversation"]["requestBody"]["content"]["application/json"];

/** A priority for POST conversations/{id}/toggle_priority; null clears it. */
type ConversationPriority = NonNullable<
  NonNullable<operations["toggle-priority-of-a-conversation"]["requestBody"]>["content"]["application/json"]["priority"]
>;

interface NewMessage {
  content: string;
  private: boolean;
  files: ReadonlyArray<{ blob: Blob; filename: string }>;
}

export type ChatwootClient = ReturnType<typeof chatwootClient>;

export function chatwootClient(baseUrl: string, token: string, fetch: Fetch) {
  const client = createClient<paths>({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    headers: { api_access_token: token },
    fetch,
  });

  async function data<T>(operation: string, pending: Promise<{ data?: T; response: Response }>): Promise<T> {
    const { data, response } = await pending;
    if (!response.ok || data === undefined) throw new ChatwootError(response.status, operation);
    return data;
  }

  async function ensureOk(operation: string, pending: Promise<{ response: Response }>): Promise<void> {
    const { response } = await pending;
    if (!response.ok) throw new ChatwootError(response.status, operation);
  }

  /** Messages oldest first, or undefined when the conversation does not exist (see `notFound`). */
  async function listMessages(accountId: number, conversationId: number, query: { after?: number; before?: number }) {
    const { data, response } = await client.GET(
      "/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages",
      { params: { path: { account_id: accountId, conversation_id: conversationId }, query } },
    );
    if (notFound(response)) return undefined;
    if (!response.ok || data === undefined) throw new ChatwootError(response.status, "list messages");
    return messageListSchema.parse(data).payload.toSorted((a, b) => a.id - b.id);
  }

  return {
    /** The conversation, or undefined when it does not exist (it was deleted). */
    async getConversation(accountId: number, conversationId: number): Promise<ChatwootConversation | undefined> {
      const { data, response } = await client.GET("/api/v1/accounts/{account_id}/conversations/{conversation_id}", {
        params: { path: { account_id: accountId, conversation_id: conversationId } },
      });
      if (notFound(response)) return undefined;
      if (!response.ok || data === undefined) throw new ChatwootError(response.status, "get conversation");
      return data;
    },

    /** Messages with an id above `after`, oldest first; without `after`, the latest page. */
    async listMessages(accountId: number, conversationId: number, after?: number): Promise<ChatwootMessage[]> {
      const messages = await listMessages(accountId, conversationId, after === undefined ? {} : { after });
      if (!messages) throw new ChatwootError(404, "list messages");
      return messages;
    },

    /**
     * One message, or undefined if it or its conversation does not exist. Asks for the ids between
     * `messageId - 1` and `messageId + 1`, which contains it whether `after` is read inclusively
     * (MessageFinder#messages_between at v4.18.0) or exclusively (as the spec describes it).
     */
    async getMessage(
      accountId: number,
      conversationId: number,
      messageId: number,
    ): Promise<ChatwootMessage | undefined> {
      const messages = await listMessages(accountId, conversationId, { after: messageId - 1, before: messageId + 1 });
      return messages?.find((message) => message.id === messageId);
    },

    async inboxName(accountId: number, inboxId: number): Promise<string | undefined> {
      const inbox = await data(
        "get inbox",
        client.GET("/api/v1/accounts/{account_id}/inboxes/{id}", {
          params: { path: { account_id: accountId, id: inboxId } },
        }),
      );
      return inbox.name;
    },

    /**
     * One page of conversations of any status and assignee, most recent activity first
     * (Conversations::SortService's default, `last_activity_at_desc`, at v4.18.0).
     */
    async listConversations(accountId: number, page: number): Promise<ChatwootConversation[]> {
      const list = await data(
        "list conversations",
        client.GET("/api/v1/accounts/{account_id}/conversations", {
          params: { path: { account_id: accountId }, query: { status: "all", assignee_type: "all", page } },
        }),
      );
      return list.data?.payload ?? [];
    },

    getProfile() {
      return data("get profile", client.GET("/api/v1/profile"));
    },

    listAgents(accountId: number) {
      return data(
        "list agents",
        client.GET("/api/v1/accounts/{account_id}/agents", { params: { path: { account_id: accountId } } }),
      );
    },

    setStatus(accountId: number, conversationId: number, change: StatusChange): Promise<void> {
      return ensureOk(
        "toggle status",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_status", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: change,
        }),
      );
    },

    setPriority(accountId: number, conversationId: number, priority: ConversationPriority | null): Promise<void> {
      return ensureOk(
        "toggle priority",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_priority", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: { priority },
        }),
      );
    },

    setContactBlocked(accountId: number, contactId: number, blocked: boolean): Promise<void> {
      return ensureOk(
        blocked ? "block contact" : "unblock contact",
        client.PUT("/api/v1/accounts/{account_id}/contacts/{id}", {
          params: { path: { account_id: accountId, id: contactId } },
          body: { blocked },
        }),
      );
    },

    assign(accountId: number, conversationId: number, assigneeId: number): Promise<void> {
      return ensureOk(
        "assign conversation",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/assignments", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: { assignee_id: assigneeId },
        }),
      );
    },

    /**
     * Removes the conversation's assignee the way Chatwoot's dashboard does (ConversationAction.vue
     * posts `assignee_id: null`, which AssignmentsController#create applies, at v4.18.0). The
     * spec types `assignee_id` as a number only, so this body is serialized here.
     */
    unassign(accountId: number, conversationId: number): Promise<void> {
      return ensureOk(
        "unassign conversation",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/assignments", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: {},
          bodySerializer: () => JSON.stringify({ assignee_id: null }),
        }),
      );
    },

    /** The account's label names (Chatwoot saves them in lower case). */
    async listLabels(accountId: number): Promise<string[]> {
      const list = await data(
        "list labels",
        client.GET("/api/v1/accounts/{account_id}/labels", { params: { path: { account_id: accountId } } }),
      );
      return (list.payload ?? []).flatMap((label) => (label.title ? [label.title] : []));
    },

    async conversationLabels(accountId: number, conversationId: number): Promise<string[]> {
      const list = await data(
        "list conversation labels",
        client.GET("/api/v1/accounts/{account_id}/conversations/{conversation_id}/labels", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
        }),
      );
      return list.payload ?? [];
    },

    /** Replaces the conversation's labels (the spec's "Add Labels" overwrites the list). */
    setLabels(accountId: number, conversationId: number, labels: string[]): Promise<void> {
      return ensureOk(
        "set labels",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/labels", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: { labels },
        }),
      );
    },

    /** Sets one conversation custom attribute, keeping the others (`merge`). */
    setCustomAttribute(accountId: number, conversationId: number, key: string, value: string): Promise<void> {
      return ensureOk(
        "set custom attribute",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/custom_attributes", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: { custom_attributes: { [key]: value }, merge: true },
        }),
      );
    },

    /**
     * Sends an outgoing message (or private note). With files it is sent as the spec's
     * multipart/form-data body; the generated type renders its `attachments[]` binaries as
     * strings, so the serializer appends the files itself.
     */
    createMessage(accountId: number, conversationId: number, message: NewMessage): Promise<void> {
      const fields = { content: message.content, message_type: "outgoing", private: message.private } as const;
      const multipart = (body: MultipartMessage) => {
        const form = new FormData();
        if (body.content) form.append("content", body.content);
        if (body.message_type) form.append("message_type", body.message_type);
        form.append("private", String(body.private ?? false));
        for (const file of message.files) form.append("attachments[]", file.blob, file.filename);
        return form;
      };
      return ensureOk(
        "create message",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: fields,
          ...(message.files.length === 0 ? {} : { bodySerializer: () => multipart(fields) }),
        }),
      );
    },
  };
}

/**
 * Chatwoot's documented 404 for a conversation route ("Conversation not found"), a JSON error
 * body (RequestExceptionHandler#render_not_found_error). A 404 without it, e.g. from a proxy,
 * is treated as any other failure.
 */
function notFound(response: Response): boolean {
  return response.status === 404 && (response.headers.get("content-type")?.includes("application/json") ?? false);
}

const MESSAGE_TYPES: Record<number, MessageType> = { 0: "incoming", 1: "outgoing", 2: "activity", 3: "template" };

export function toRelayConversation(conversationId: number, conversation: ChatwootConversation): RelayConversation {
  const meta = conversation.meta;
  const assignee = meta?.assignee;
  return {
    id: conversationId,
    status: conversation.status,
    channel: meta?.channel ?? null,
    priority: conversation.priority ?? null,
    labels: conversation.labels ?? [],
    contact: {
      name: meta?.sender?.name ?? null,
      email: meta?.sender?.email ?? null,
      phone: meta?.sender?.phone_number ?? null,
      blocked: meta?.sender?.blocked ?? false,
      avatarUrl: meta?.sender?.thumbnail ?? null,
    },
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    customAttributes: conversation.custom_attributes ?? {},
  };
}

export function toRelayMessage(
  message: ChatwootMessage,
  context: {
    account: { id: number; name: string };
    inboxName?: string | null;
    conversation: RelayConversation;
    mentionedAgents?: ReadonlyMap<number, string>;
    discordAvatarUrl?: string;
  },
): RelayMessage {
  return {
    id: message.id,
    createdAt: message.created_at ?? null,
    messageType: MESSAGE_TYPES[message.message_type] ?? "template",
    private: message.private ?? false,
    deleted: message.content_attributes?.deleted === true,
    content: messageContent(message),
    emailSubject: message.content_attributes?.email?.subject ?? null,
    autoReply: message.content_attributes?.email?.auto_reply === true,
    attachments: (message.attachments ?? []).flatMap(toRelayAttachment),
    items: ITEM_CONTENT_TYPES.has(message.content_type ?? "") ? toRelayItems(message.content_attributes?.items) : [],
    sender: message.sender
      ? {
          name: message.sender.name,
          email: message.sender.email,
          type: message.sender.type,
          avatarUrl: message.sender.thumbnail,
        }
      : undefined,
    account: context.account,
    inboxName: context.inboxName ?? null,
    conversation: context.conversation,
    ...(context.mentionedAgents ? { mentionedAgents: context.mentionedAgents } : {}),
    ...(context.discordAvatarUrl ? { discordAvatarUrl: context.discordAvatarUrl } : {}),
  };
}

/**
 * What Chatwoot itself shows and forwards (Message#ensure_processed_message_content, used by its
 * Slack integration at v4.18.0): for an email, the reply without its quoted history.
 */
function messageContent(message: ChatwootMessage): string {
  const email = message.content_attributes?.email;
  return email?.text_content?.quoted ?? email?.html_content?.quoted ?? message.content ?? "";
}

function toRelayAttachment(attachment: z.infer<typeof attachmentSchema>): RelayAttachment[] {
  switch (attachment.file_type) {
    case "contact": {
      const meta = attachment.meta;
      const name = [meta?.firstName ?? meta?.first_name, meta?.lastName ?? meta?.last_name].filter(Boolean).join(" ");
      return [{ type: "contact", name, phone: attachment.fallback_title ?? "" }];
    }
    case "fallback":
      return [{ type: "file", url: attachment.data_url ?? "", label: attachment.fallback_title ?? "" }];
    case "location":
      return [
        {
          type: "location",
          title: attachment.fallback_title ?? "",
          latitude: attachment.coordinates_lat ?? 0,
          longitude: attachment.coordinates_long ?? 0,
          url: attachment.data_url ?? "",
        },
      ];
    default: {
      const label = LINK_LABELS[attachment.file_type ?? ""];
      if (!attachment.data_url) return [];
      return [{ type: "file", url: attachment.data_url, ...(label ? { label } : {}) }];
    }
  }
}

function toRelayItems(items: unknown): RelayItem[] {
  const parsed = z.array(itemSchema).safeParse(items);
  if (!parsed.success) return [];
  return parsed.data.map((item) => ({
    title: item.title ?? item.value ?? "",
    description: item.description ?? "",
    url: item.link ?? item.media_url ?? "",
    links: (item.actions ?? []).flatMap((action) => (action.uri ? [{ text: action.text ?? "", url: action.uri }] : [])),
  }));
}
