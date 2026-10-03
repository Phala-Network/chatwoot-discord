// Chatwoot account webhooks. Verified against Chatwoot v4.18.0 lib/webhooks/trigger.rb:
//   X-Chatwoot-Timestamp: unix seconds
//   X-Chatwoot-Signature: "sha256=" + hex(HMAC-SHA256(secret, "#{timestamp}.#{raw body}"))
// Account webhooks are sent once (Webhooks::Trigger logs failures and WebhookJob does not
// retry), so deliveries need no dedupe; the relay is idempotent anyway (see relay/processor.ts).

import { isRecord } from "../../../../shared/json.ts";
import { hasResponse, interactiveMessage } from "../relay/response.ts";

export { isFreshTimestamp, verifyChatwootSignature } from "../../../../shared/chatwoot/signature.ts";

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
 * Message updates use Message#webhook_data, with `message_type`, `content_type`, and
 * `content_attributes`: a deletion, which sets `content_attributes.deleted`
 * (MessagesController#destroy); a customer's response to an interactive message, which sets
 * `submitted_values` or `submitted_email` (Widget::MessagesController#update); and an outgoing
 * message whose delivery status can change (including failed replies retried as sent).
 * Outgoing updates invalidate unfinished answer scans before the first notification decision.
 * The payload does not say what changed, so any update of such a message is queued; the job posts once.
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
  return deleted || responded || payload.message_type === "outgoing"
    ? { type: "message-updated", accountId, conversationId, messageId: payload.id }
    : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
