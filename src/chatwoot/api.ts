// Chatwoot REST API (v4.18.0), called only through routes listed in its published OpenAPI spec.
// Requests and most responses are typed by the generated schema (src/chatwoot/schema.d.ts).
// Messages are validated with zod instead, because the spec's `message` schema does not match
// what the API returns for the fields the relay reads (see messageSchema).

import createClient from "openapi-fetch";
import { z } from "zod";
import type { MessageType, RelayConversation, RelayMessage } from "../relay/types.js";
import type { components, operations, paths } from "./schema.js";

export type Fetch = (input: Request) => Promise<Response>;

/** A non-2xx answer from Chatwoot. Only the status is kept: bodies may echo user content. */
export class ChatwootError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`Chatwoot ${operation} failed with HTTP ${status}`);
    this.name = "ChatwootError";
  }
}

/**
 * A conversation as returned by GET conversations/{id} and in the conversation list. The spec's
 * `status` enum omits `snoozed`, which the API does return, so the relay treats it as a string.
 */
export type ChatwootConversation = components["schemas"]["conversation_show"];

const text = z.string().nullish();

/**
 * The spec's `message` schema describes a single `attachment` object and leaves `sender` and
 * `content_attributes` untyped, while the API returns `attachments[]` (app/views/api/v1/models/
 * _message.json.jbuilder), a sender with `name`/`email`/`type`/`thumbnail`, and content
 * attributes such as `email.subject` and `deleted` (app/models/message.rb). Only those fields
 * are read.
 */
const messageSchema = z.object({
  id: z.number(),
  content: text,
  message_type: z.number(),
  private: z.boolean().nullish(),
  content_attributes: z
    .object({ email: z.object({ subject: text }).nullish(), deleted: z.boolean().nullish() })
    .nullish()
    .catch(null),
  sender: z.object({ name: text, email: text, type: text, thumbnail: text }).nullish(),
  attachments: z.array(z.object({ data_url: text })).nullish(),
});
export type ChatwootMessage = z.infer<typeof messageSchema>;
const messageListSchema = z.object({ payload: z.array(messageSchema) });

/** Chatwoot returns up to 100 messages per `after` page. */
export const MESSAGE_PAGE_SIZE = 100;

type MultipartMessage =
  operations["create-a-new-message-in-a-conversation"]["requestBody"]["content"]["multipart/form-data"];

export interface NewMessage {
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

    setStatus(accountId: number, conversationId: number, status: "open" | "resolved"): Promise<void> {
      return ensureOk(
        "toggle status",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_status", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: { status },
        }),
      );
    },

    blockContact(accountId: number, contactId: number): Promise<void> {
      return ensureOk(
        "block contact",
        client.PUT("/api/v1/accounts/{account_id}/contacts/{id}", {
          params: { path: { account_id: accountId, id: contactId } },
          body: { blocked: true },
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
    inboxId: conversation.inbox_id ?? null,
    contact: {
      name: meta?.sender?.name ?? null,
      email: meta?.sender?.email ?? null,
      blocked: meta?.sender?.blocked ?? false,
    },
    assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email } : null,
    customAttributes: conversation.custom_attributes ?? {},
  };
}

export function toRelayMessage(
  message: ChatwootMessage,
  context: { account: { id: number; name: string }; inboxName?: string | null; conversation: RelayConversation },
): RelayMessage {
  return {
    id: message.id,
    messageType: MESSAGE_TYPES[message.message_type] ?? "template",
    private: message.private ?? false,
    deleted: message.content_attributes?.deleted === true,
    content: message.content ?? "",
    emailSubject: message.content_attributes?.email?.subject ?? null,
    attachmentUrls: (message.attachments ?? []).flatMap((attachment) =>
      attachment.data_url ? [attachment.data_url] : [],
    ),
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
  };
}
