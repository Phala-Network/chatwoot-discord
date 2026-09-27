// Chatwoot REST API (v4.18.0). Requests are typed by the generated OpenAPI schema; responses are
// validated with zod because the published spec omits fields the API does return (e.g. the
// conversation `meta` block on list responses).

import createClient from "openapi-fetch";
import { z } from "zod";
import type { MessageType, RelayConversation, RelayMessage } from "../relay/types.js";
import type { paths } from "./schema.js";

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

const text = z.string().nullish();

const assigneeSchema = z.object({ id: z.number().nullish(), name: text, available_name: text, email: text });

export const conversationSchema = z.object({
  id: z.number(),
  status: z.string(),
  inbox_id: z.number().nullish(),
  custom_attributes: z.record(z.string(), z.unknown()).nullish(),
  meta: z
    .object({
      sender: z.object({ name: text, email: text, blocked: z.boolean().nullish() }).nullish(),
      channel: text,
      assignee: assigneeSchema.nullish(),
    })
    .nullish(),
  /** The latest message (any type), as included by the conversation partial. */
  messages: z.array(z.object({ id: z.number() })).nullish(),
});
export type ChatwootConversation = z.infer<typeof conversationSchema>;

const messageSchema = z.object({
  id: z.number(),
  content: text,
  message_type: z.number(),
  private: z.boolean().nullish(),
  content_attributes: z
    .object({ email: z.object({ subject: text }).nullish() })
    .nullish()
    .catch(null),
  sender: z.object({ name: text, email: text, type: text, thumbnail: text }).nullish(),
  attachments: z.array(z.object({ data_url: text })).nullish(),
});
export type ChatwootMessage = z.infer<typeof messageSchema>;

const messageListSchema = z.object({ payload: z.array(messageSchema) });
const conversationListSchema = z.object({ data: z.object({ payload: z.array(conversationSchema) }) });
const inboxSchema = z.object({ name: z.string() });
const profileSchema = z.object({
  id: z.number(),
  name: z.string(),
  available_name: text,
  email: z.string(),
  accounts: z.array(z.object({ id: z.number() })).default([]),
});
export type ChatwootProfile = z.infer<typeof profileSchema>;
const agentListSchema = z.array(
  z.object({ id: z.number(), name: z.string(), available_name: text, email: z.string() }),
);

/** Chatwoot returns up to 100 messages per `after` page. */
export const MESSAGE_PAGE_SIZE = 100;

export interface NewMessage {
  content: string;
  private: boolean;
  files: ReadonlyArray<{ blob: Blob; filename: string }>;
}

export type ChatwootClient = ReturnType<typeof chatwootClient>;

export function chatwootClient(baseUrl: string, token: string, fetch: Fetch) {
  const root = baseUrl.replace(/\/+$/, "");
  const client = createClient<paths>({ baseUrl: root, headers: { api_access_token: token }, fetch });

  async function parse<T>(
    operation: string,
    pending: Promise<{ response: Response; data?: unknown }>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const { response, data } = await pending;
    if (!response.ok) throw new ChatwootError(response.status, operation);
    return schema.parse(data);
  }

  async function ensureOk(operation: string, pending: Promise<{ response: Response }>): Promise<void> {
    const { response } = await pending;
    if (!response.ok) throw new ChatwootError(response.status, operation);
  }

  /**
   * Calls a route that exists in Chatwoot v4.18.0 but not in its published OpenAPI spec.
   * Each caller documents where the route is defined.
   */
  async function unlisted(operation: string, method: "GET" | "POST", path: string): Promise<unknown> {
    const response = await fetch(
      new Request(`${root}${path}`, { method, headers: { api_access_token: token, accept: "application/json" } }),
    );
    if (!response.ok) throw new ChatwootError(response.status, operation);
    return response.headers.get("content-type")?.includes("application/json") ? response.json() : undefined;
  }

  return {
    getConversation(accountId: number, conversationId: number): Promise<ChatwootConversation> {
      return parse(
        "get conversation",
        client.GET("/api/v1/accounts/{account_id}/conversations/{conversation_id}", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
        }),
        conversationSchema,
      );
    },

    /** Messages with an id above `after`, oldest first; without `after`, the latest page. */
    async listMessages(accountId: number, conversationId: number, after?: number): Promise<ChatwootMessage[]> {
      const list = await parse(
        "list messages",
        client.GET("/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages", {
          params: {
            path: { account_id: accountId, conversation_id: conversationId },
            query: after === undefined ? {} : { after },
          },
        }),
        messageListSchema,
      );
      return list.payload.toSorted((a, b) => a.id - b.id);
    },

    async inboxName(accountId: number, inboxId: number): Promise<string> {
      const inbox = await parse(
        "get inbox",
        client.GET("/api/v1/accounts/{account_id}/inboxes/{id}", {
          params: { path: { account_id: accountId, id: inboxId } },
        }),
        inboxSchema,
      );
      return inbox.name;
    },

    /**
     * Conversations of any status updated within the last `seconds`, unpaginated.
     * `updated_within` is not in the published spec. Verified at v4.18.0:
     * app/finders/conversation_finder.rb#conversations skips pagination and filters
     * `conversations.updated_at > now - updated_within` when the param is present; new messages
     * touch `updated_at` (app/models/message.rb). Visibility follows the token owner's inboxes.
     */
    async listUpdatedConversations(accountId: number, seconds: number): Promise<ChatwootConversation[]> {
      const query = new URLSearchParams({
        status: "all",
        assignee_type: "all",
        updated_within: String(Math.ceil(seconds)),
      });
      const data = await unlisted(
        "list updated conversations",
        "GET",
        `/api/v1/accounts/${accountId}/conversations?${query.toString()}`,
      );
      return conversationListSchema.parse(data).data.payload;
    },

    getProfile(): Promise<ChatwootProfile> {
      return parse("get profile", client.GET("/api/v1/profile"), profileSchema);
    },

    listAgents(accountId: number) {
      return parse(
        "list agents",
        client.GET("/api/v1/accounts/{account_id}/agents", { params: { path: { account_id: accountId } } }),
        agentListSchema,
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
     * Chatwoot's "Block contact": resolves the conversation, blocks the contact, and logs an
     * activity message. Not in the published spec. Verified at v4.18.0: config/routes.rb
     * (`post :mute` on conversations), ConversationsController#mute, and
     * app/models/concerns/conversation_mute_helpers.rb#mute!.
     */
    async mute(accountId: number, conversationId: number): Promise<void> {
      await unlisted("mute conversation", "POST", `/api/v1/accounts/${accountId}/conversations/${conversationId}/mute`);
    },

    /** Sends an outgoing message (or private note), as multipart when it carries files. */
    createMessage(accountId: number, conversationId: number, message: NewMessage): Promise<void> {
      const fields = { content: message.content, message_type: "outgoing" as const, private: message.private };
      return ensureOk(
        "create message",
        client.POST("/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages", {
          params: { path: { account_id: accountId, conversation_id: conversationId } },
          body: fields,
          ...(message.files.length === 0
            ? {}
            : {
                bodySerializer: () => {
                  const form = new FormData();
                  if (fields.content !== "") form.append("content", fields.content);
                  form.append("message_type", fields.message_type);
                  form.append("private", String(fields.private));
                  for (const file of message.files) form.append("attachments[]", file.blob, file.filename);
                  return form;
                },
              }),
        }),
      );
    },
  };
}

const MESSAGE_TYPES: Record<number, MessageType> = { 0: "incoming", 1: "outgoing", 2: "activity", 3: "template" };

export function toRelayConversation(conversation: ChatwootConversation): RelayConversation {
  const meta = conversation.meta;
  return {
    id: conversation.id,
    status: conversation.status,
    channel: meta?.channel ?? null,
    inboxId: conversation.inbox_id ?? null,
    contact: {
      name: meta?.sender?.name ?? null,
      email: meta?.sender?.email ?? null,
      blocked: meta?.sender?.blocked ?? false,
    },
    assignee: meta?.assignee
      ? { id: meta.assignee.id ?? undefined, name: meta.assignee.name, email: meta.assignee.email }
      : null,
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
