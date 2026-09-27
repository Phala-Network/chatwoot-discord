// Chatwoot account webhooks. Verified against Chatwoot v4.18.0 lib/webhooks/trigger.rb:
//   X-Chatwoot-Timestamp: unix seconds
//   X-Chatwoot-Signature: "sha256=" + hex(HMAC-SHA256(secret, "#{timestamp}.#{raw body}"))
// Account webhooks are sent once (Webhooks::Trigger logs failures and WebhookJob does not
// retry), so deliveries need no dedupe; the relay is idempotent anyway (see relay/processor.ts).

import { hasResponse, interactiveMessage } from "../relay/response.js";

export const TIMESTAMP_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

export function isFreshTimestamp(timestamp: string | undefined, nowSeconds: number): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(nowSeconds - Number(timestamp)) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/** Constant-time check (WebCrypto HMAC verify) of a Chatwoot webhook signature. */
export async function verifyChatwootSignature(
  secret: string,
  timestamp: string,
  body: Uint8Array,
  signatureHeader: string | undefined,
): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader ?? "");
  const hex = match?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  return crypto.subtle.verify("HMAC", key, hexToBytes(hex), signed);
}

const CONVERSATION_EVENTS = new Set(["conversation_updated", "conversation_status_changed"]);

export type WebhookTarget =
  | { type: "conversation"; accountId: number; conversationId: number }
  | { type: "message-updated"; accountId: number; conversationId: number; messageId: number };

/**
 * What an event asks the relay to do, or undefined for events it ignores. Message payloads carry
 * `conversation.id` (the display id); conversation payloads are the conversation.
 *
 * Two message updates are relayed (the payload is Message#webhook_data, with `content_type` and
 * `content_attributes`): a deletion, which sets `content_attributes.deleted`
 * (MessagesController#destroy), and a customer's response to an interactive message, which sets
 * `submitted_values` or `submitted_email` (Widget::MessagesController#update). The payload does
 * not say what changed, so any update of a message with a response is queued; the job posts a
 * response only once.
 */
export function eventTarget(payload: unknown): WebhookTarget | undefined {
  if (!isRecord(payload) || typeof payload.event !== "string") return undefined;
  const accountId = isRecord(payload.account) ? payload.account.id : undefined;
  if (!isPositiveInteger(accountId)) return undefined;
  if (CONVERSATION_EVENTS.has(payload.event)) {
    return isPositiveInteger(payload.id) ? { type: "conversation", accountId, conversationId: payload.id } : undefined;
  }
  const conversationId = isRecord(payload.conversation) ? payload.conversation.id : undefined;
  if (!isPositiveInteger(conversationId)) return undefined;
  if (payload.event === "message_created") return { type: "conversation", accountId, conversationId };
  if (payload.event !== "message_updated" || !isPositiveInteger(payload.id)) return undefined;
  const deleted = isRecord(payload.content_attributes) && payload.content_attributes.deleted === true;
  const responded = hasResponse(interactiveMessage(payload.content_type, payload.content, payload.content_attributes));
  return deleted || responded
    ? { type: "message-updated", accountId, conversationId, messageId: payload.id }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
