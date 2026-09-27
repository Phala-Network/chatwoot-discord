// Chatwoot account webhooks. Verified against Chatwoot v4.18.0 lib/webhooks/trigger.rb:
//   X-Chatwoot-Timestamp: unix seconds
//   X-Chatwoot-Signature: "sha256=" + hex(HMAC-SHA256(secret, "#{timestamp}.#{raw body}"))
//   X-Chatwoot-Delivery:  a UUID per delivery (app/listeners/webhook_listener.rb)

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

const CONVERSATION_EVENTS = new Set(["conversation_created", "conversation_updated", "conversation_status_changed"]);
const MESSAGE_EVENTS = new Set(["message_created", "message_updated"]);

/**
 * The account and conversation (display id) an event concerns, or undefined for events the relay
 * ignores. Message payloads carry `conversation.id`; conversation payloads are the conversation.
 */
export function eventTarget(payload: unknown): { accountId: number; conversationId: number } | undefined {
  if (!isRecord(payload) || typeof payload.event !== "string") return undefined;
  const accountId = isRecord(payload.account) ? payload.account.id : undefined;
  let conversationId: unknown;
  if (MESSAGE_EVENTS.has(payload.event))
    conversationId = isRecord(payload.conversation) ? payload.conversation.id : undefined;
  else if (CONVERSATION_EVENTS.has(payload.event)) conversationId = payload.id;
  if (!isPositiveInteger(accountId) || !isPositiveInteger(conversationId)) return undefined;
  return { accountId, conversationId };
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
