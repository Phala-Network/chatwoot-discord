// Chatwoot account webhooks. Verified against Chatwoot v4.18.0 lib/webhooks/trigger.rb:
//   X-Chatwoot-Timestamp: unix seconds
//   X-Chatwoot-Signature: "sha256=" + hex(HMAC-SHA256(secret, "#{timestamp}.#{raw body}"))
// Account webhooks are sent once (Webhooks::Trigger logs failures and WebhookJob does not
// retry), so deliveries need no dedupe; the relay is idempotent anyway (see relay/processor.ts).

import { isRecord } from "../json.ts";
import { hasResponse, interactiveMessage } from "../relay/response.ts";

const TIMESTAMP_TOLERANCE_SECONDS = 300;

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

/**
 * How long a conversation event waits before its sync. The activity message for a change
 * ("Assigned to …", "Resolved by …") is created afterwards by Conversations::ActivityMessageJob
 * on Sidekiq's `high` queue, and activity messages send no webhook (`webhook_sendable?` in
 * app/models/concerns/message_filter_helpers.rb at v4.18.0). The event's own webhook takes two
 * jobs (EventDispatcherJob, then WebhookJob on `medium`), so the activity usually exists
 * already; the wait covers a busy queue. Anything later is picked up by the sweep.
 */
export const ACTIVITY_WAIT_MS = 10_000;

type WebhookTarget =
  | { type: "conversation"; accountId: number; conversationId: number; delayMs: number }
  | { type: "message-updated"; accountId: number; conversationId: number; messageId: number };

/**
 * What an event asks the relay to do, or undefined for events it ignores. Message payloads carry
 * `conversation.id` (the display id); conversation payloads are the conversation.
 *
 * Three message updates are relayed (the payload is Message#webhook_data, with `message_type`,
 * `content_type`, and `content_attributes`): a deletion, which sets `content_attributes.deleted`
 * (MessagesController#destroy); a customer's response to an interactive message, which sets
 * `submitted_values` or `submitted_email` (Widget::MessagesController#update); and an outgoing
 * message the channel failed to deliver, which gets status `failed` and
 * `content_attributes.external_error` (e.g. Whatsapp::SendOnWhatsappService). The payload does
 * not say what changed, so any update of such a message is queued; the job posts once.
 */
export function eventTarget(payload: unknown): WebhookTarget | undefined {
  if (!isRecord(payload) || typeof payload.event !== "string") return undefined;
  const accountId = isRecord(payload.account) ? payload.account.id : undefined;
  if (!isPositiveInteger(accountId)) return undefined;
  if (CONVERSATION_EVENTS.has(payload.event)) {
    return isPositiveInteger(payload.id)
      ? { type: "conversation", accountId, conversationId: payload.id, delayMs: ACTIVITY_WAIT_MS }
      : undefined;
  }
  const conversationId = isRecord(payload.conversation) ? payload.conversation.id : undefined;
  if (!isPositiveInteger(conversationId)) return undefined;
  if (payload.event === "message_created") return { type: "conversation", accountId, conversationId, delayMs: 0 };
  if (payload.event !== "message_updated" || !isPositiveInteger(payload.id)) return undefined;
  const attributes = isRecord(payload.content_attributes) ? payload.content_attributes : {};
  const deleted = attributes.deleted === true;
  const responded = hasResponse(interactiveMessage(payload.content_type, payload.content, attributes));
  const failed = payload.message_type === "outgoing" && typeof attributes.external_error === "string";
  return deleted || responded || failed
    ? { type: "message-updated", accountId, conversationId, messageId: payload.id }
    : undefined;
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
