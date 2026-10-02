// Chatwoot's status activity is the turn boundary. Keep only the guard needed to reject an
// obsolete handoff or a missing/deleted boundary, not an effects ledger or a turn history.
import { z } from "zod";
import { type ChatwootClient, type ChatwootMessage, MESSAGE_HISTORY_PAGE_SIZE } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import type { RoutingStore } from "./routing.ts";
import type { Transition } from "./webhook.ts";

const guardSchema = z.object({
  boundary: z.number().optional(),
  transitionAt: z.number().optional(),
  expected: z.object({ status: z.string(), at: z.number() }).optional(),
  handoff: z.boolean().default(false),
});
type Guard = z.infer<typeof guardSchema>;

export function readGuard(store: RoutingStore, accountId: number, conversationId: number): Guard {
  const parsed = guardSchema.safeParse(parseJson(store.get(`turn:${accountId}:${conversationId}`)));
  return parsed.success ? parsed.data : { handoff: false };
}

export function saveGuard(store: RoutingStore, accountId: number, conversationId: number, guard: Guard): void {
  store.set(`turn:${accountId}:${conversationId}`, JSON.stringify(guard));
}

export function expectActivity(
  store: RoutingStore,
  accountId: number,
  conversationId: number,
  transition: Transition,
): void {
  const guard = readGuard(store, accountId, conversationId);
  if (transition.at <= (guard.transitionAt ?? 0)) return;
  saveGuard(store, accountId, conversationId, {
    ...guard,
    expected: transition,
    transitionAt: transition.at,
    handoff: false,
  });
}

export function requestHandoff(store: RoutingStore, accountId: number, conversationId: number): void {
  saveGuard(store, accountId, conversationId, { ...readGuard(store, accountId, conversationId), handoff: true });
}

export class ActivityPendingError extends Error {
  constructor() {
    super("Chatwoot status activity is not available yet");
    this.name = "ActivityPendingError";
  }
}

export async function readTurn(
  chatwoot: ChatwootClient,
  store: RoutingStore,
  accountId: number,
  conversationId: number,
) {
  const guard = readGuard(store, accountId, conversationId);
  const messages: ChatwootMessage[] = [];
  let before: number | undefined;
  let boundary: ChatwootMessage | undefined;
  let complete = false;
  let deleted = false;
  for (let page = 0; page < 5; page += 1) {
    const batch = await chatwoot.listMessages(accountId, conversationId, before === undefined ? {} : { before });
    for (const message of batch.toReversed()) {
      if (message.message_type === 2 && message.content_attributes?.deleted) {
        deleted = true;
        break;
      }
      if (message.content_attributes?.activity?.type === "conversation_status_changed") {
        boundary = message;
        break;
      }
      messages.push(message);
    }
    complete = boundary !== undefined || batch.length < MESSAGE_HISTORY_PAGE_SIZE;
    if (complete || deleted) break;
    const next = batch[0]?.id;
    if (next === undefined || (before !== undefined && next >= before)) break;
    before = next;
  }
  const missing = guard.boundary !== undefined && (boundary?.id ?? 0) < guard.boundary;
  const expected = guard.expected;
  const activity = boundary?.content_attributes?.activity;
  // Activity timestamps have second precision. The status webhook carries fractional seconds.
  const late =
    expected &&
    (!boundary || (boundary.created_at ?? 0) < Math.floor(expected.at) || activity?.status !== expected.status);
  if (late && !guard.handoff && !deleted && !missing) throw new ActivityPendingError();
  if (boundary && boundary.id !== guard.boundary && guard.boundary !== undefined && !missing && !late) {
    guard.handoff = false;
  }
  if (!missing && complete) guard.boundary = boundary?.id ?? 0;
  if (expected && !late) delete guard.expected;
  if (deleted || missing || !complete) guard.handoff = true;
  saveGuard(store, accountId, conversationId, guard);
  return { messages: messages.toReversed(), boundary: boundary?.id ?? 0, handoff: guard.handoff };
}
