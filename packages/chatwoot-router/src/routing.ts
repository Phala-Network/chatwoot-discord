// Routing: when `routing` is configured for an account, a new ticket gets its owner assigned and
// its topic label added by TypeSafe Jev (https://docs.typesafe.ai), a classifier that answers a multiple
// choice question with a probability per option.
//
// A ticket is routed when it is open, unassigned, and has a customer message. Jev sees the subject
// and the first customer messages (up to MAX_MESSAGES), with identifiers (emails, URLs, addresses,
// keys, phone numbers, IP addresses, handles, and the contact's name) removed. An owner below
// `minConfidence`, or "unclear", is not assigned: Jev is asked again when the customer adds a
// message, until an owner is found or MAX_MESSAGES were seen; then the ticket stays for a person.
// Customer messages are looked for in the next PAGES pages of messages (notes and activity lines
// count too): one beyond them is not seen, and the ticket is then not snoozed.
// With `snoozeUnclear`, Jev also tells whether the customer asked for anything yet; such a ticket
// without a request (a greeting, a test) is snoozed until the customer's next message (which reopens
// it), so it waits for detail instead of escalating; once MAX_MESSAGES were seen it stays open. One
// with a request stays open for a person (the support queue escalates it).
// Jev's decision is recorded (without expiry) before it is applied, so a retry applies the same
// decision without asking Jev again; it is applied to the conversation as it is after Jev answered,
// so an assignee or topic label someone set meanwhile is kept. A customer message newer than those
// Jev was given makes the decision stale: the ticket is then not snoozed, and a decision not applied
// yet is made again. (A message in the moment between that check and the snooze stays snoozed until
// the customer's next message reopens the ticket; the support queue lists it meanwhile.)
//
// With `kinds`, Jev also tells which configured kind of ticket it is, if any. A kind Jev is confident
// about is added as a label beside the ticket's one topic label (kinds are labels too, of another
// family: a topic is a category, a kind may act), and acts with the decision: `status` sets the
// ticket aside (resolved, or snoozed until the customer's next message, either of which that message
// reopens) instead of routing it; `cannedResponse` sends that Chatwoot canned response, read when
// it is sent (none while it does not exist), as the account's Chatwoot agent bot, under its own name,
// which assigns nobody and is no human first reply; a kind with both replies, then sets the ticket
// aside (a reply to a junk report, for example). A reply is sent at most once per ticket: it is
// recorded before it is sent, so a failed send is not retried, and a reply is never repeated. Once a
// kind replied or set the ticket aside, the customer messages it handled (those Jev was given) do not
// call the triage bot (see routing_handled): the relay posts them after routing, unless routing
// fails or is late.

import ipRegex from "ip-regex";
import { z } from "zod";
import {
  type ChatwootClient,
  type ChatwootMessage,
  chatwootClient,
  type Fetch,
  MESSAGE_PAGE_SIZE,
  messageContent,
  toRelayConversation,
} from "../../../shared/chatwoot/api.ts";
import { log } from "../../../shared/log.ts";
import { writeCompletion } from "./completion.ts";
import type { Settings } from "./config.ts";

/** Jev's answer when no owner fits; also the reserved route name. */
export const UNCLEAR = "unclear";
const UNCLEAR_CRITERION =
  "The message has no concrete request, mixes several of the other areas, concerns another product, or cannot be " +
  "assigned to exactly one of them.";
/** With `snoozeUnclear`: whether the customer asked for anything yet. */
const REQUEST_CRITERIA = {
  request:
    "The customer asks for support, information, or an action: a question about a product or service, a problem, " +
    "or something to do, however briefly.",
  none:
    'No request yet: a greeting or a check that someone is there (such as "hi" or "hello, anyone there?"), a test, ' +
    "a name or contact details alone, or a few words that ask for nothing.",
};
/** Jev's answer when no kind fits; also a reserved kind name. */
const NO_KIND = "none";
const NO_KIND_CRITERION = "None of the other kinds.";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_MESSAGES = 3;
const MAX_TEXT = 1600;

const REDACTIONS = [
  /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}(?!\w)/gi, // email
  /\b(?:https?|ftp):\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi, // URL
  /\b(?:0x)?[0-9a-f]{20,}\b/gi, // hex ids, EVM addresses, hashes
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,64}(?![1-9A-HJ-NP-Za-km-z])/g, // base58 addresses
  /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{40,}(?![A-Za-z0-9_+/=-])/g, // keys and tokens
  /(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g, // phone numbers
  // IPv6 (with a zone id), whole: not inside a word or a path such as std::io, and not followed by a
  // colon (an address with a port is bracketed). Before IPv4, which an IPv6 address may end with.
  new RegExp(`(?<!\\w)(?:${ipRegex.v6().source})(?![\\w:])`, "g"),
  // IPv4, also after `key:` and before `:port`, but not inside a word or a longer dotted number (a
  // four-part version number reads as an address and is redacted too).
  new RegExp(`(?<!\\w|\\d\\.)(?:${ipRegex.v4().source})(?!\\w|\\.\\d)`, "g"),
  /(?<!\w)@[A-Za-z0-9_.-]{2,}/g, // handles
];

export interface RoutingStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface RoutingContext {
  settings: Settings;
  store: RoutingStore;
  chatwoot: ChatwootClient;
  /** Counts toward the invocation's subrequest budget, like the Chatwoot client's. */
  fetch: Fetch;
}

/**
 * `pending`: decided, not applied yet. `waiting`: applied without an owner; Jev is asked again on a
 * new customer message. `done`: final.
 */
const decisionSchema = z.object({
  owner: z.string().nullable(),
  ownerConfidence: z.number(),
  topic: z.string().nullable(),
  topicConfidence: z.number(),
  kind: z.string().nullable().default(null),
  kindConfidence: z.number().default(0),
  /** Jev is confident the customer asked for nothing yet (asked with `snoozeUnclear` only). */
  noRequest: z.boolean().default(false),
  /** Customer messages the decision was made on. */
  messages: z.number().int(),
  /** The newest customer message Jev was given: a newer one makes the decision stale. */
  lastMessageId: z.number().int().default(0),
  state: z.enum(["pending", "waiting", "done"]),
});
type Decision = z.infer<typeof decisionSchema>;
type RoutingState = Decision["state"];

const jevResponseSchema = z.object({
  answers: z.record(
    z.string(),
    z.object({
      choice: z.string(),
      probabilities: z.record(z.string(), z.number()).optional(),
      confidence: z.number().optional(),
    }),
  ),
});

class JevError extends Error {
  constructor(detail: string) {
    super(`TypeSafe Jev: ${detail}`);
    this.name = "JevError";
  }
}

function routingKey(accountId: number, conversationId: number): string {
  return `route:${accountId}:${conversationId}`;
}

/** Recorded once a kind's reply is (about to be) sent to the ticket's customer. */
function replyKey(accountId: number, conversationId: number): string {
  return `kind-reply:${accountId}:${conversationId}`;
}

/**
 * Recorded once a kind's reply was sent or the ticket set aside: the id of the latest customer message
 * the kind handled.
 */
function handledKey(accountId: number, conversationId: number): string {
  // Named for the replies it first recorded (v0.23): kept, so recorded values still count.
  return `kind-answered:${accountId}:${conversationId}`;
}

/** Whether a kind handled customer message `messageId` (replied to it or set its ticket aside). */
export function handledAutomatically(
  store: RoutingStore,
  accountId: number,
  conversationId: number,
  messageId: number,
): boolean {
  const handled = store.get(handledKey(accountId, conversationId));
  return handled !== undefined && messageId <= Number(handled);
}

/** Whether the account's routing kinds may act on a ticket: reply to it or set it aside. */
export function actsAutomatically(settings: Settings, accountId: number): boolean {
  const kinds = settings.config.routing?.kinds?.[String(accountId)] ?? {};
  const replies = settings.botToken(accountId) !== undefined;
  return Object.values(kinds).some((kind) => kind.status !== undefined || (replies && kind.cannedResponse));
}

/**
 * Sends the kind's canned response to the ticket's customer as the account's agent bot, once per
 * ticket: recorded before it is sent (so a failed send is not retried), then the customer messages it
 * answers. Whether it was sent now.
 */
async function replyOnce(
  ctx: RoutingContext,
  accountId: number,
  conversationId: number,
  decision: Decision,
  kind: Kind,
): Promise<boolean> {
  const { settings, store, chatwoot } = ctx;
  const botToken = settings.botToken(accountId);
  if (kind.cannedResponse === undefined || !botToken || store.get(replyKey(accountId, conversationId)) !== undefined) {
    return false;
  }
  const reply = await chatwoot.cannedResponse(accountId, kind.cannedResponse);
  if (reply === undefined) return false;
  store.set(replyKey(accountId, conversationId), decision.kind ?? "");
  const bot = chatwootClient(settings.config.chatwoot.baseUrl, botToken, ctx.fetch);
  await bot.createMessage(accountId, conversationId, { content: reply, private: false, files: [] });
  store.set(handledKey(accountId, conversationId), String(decision.lastMessageId));
  return true;
}

/** Whether routing is configured for the account. */
export function routesAccount(settings: Settings, accountId: number): boolean {
  return settings.config.routing?.accounts[String(accountId)] !== undefined;
}

export async function routeConversation(
  ctx: RoutingContext,
  accountId: number,
  conversationId: number,
  messageId = 0,
): Promise<void> {
  const { settings, store, chatwoot } = ctx;
  const routing = settings.config.routing;
  const owners = routing?.accounts[String(accountId)];
  if (!routing || !owners) return;
  const key = routingKey(accountId, conversationId);
  const recorded = readDecision(store.get(key));
  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) return;
  const conversation = toRelayConversation(conversationId, raw);
  const latest = await chatwoot.listMessages(accountId, conversationId);
  const seen = Math.max(
    messageId,
    ...latest.filter((message) => message.message_type === 0 && !message.private).map((message) => message.id),
  );
  const complete = async (decision?: Decision, kind: string | null = null) => {
    await writeCompletion(
      ctx,
      accountId,
      conversationId,
      Math.max(seen, decision?.lastMessageId ?? 0),
      Number(store.get(handledKey(accountId, conversationId)) ?? 0),
      kind,
    );
  };
  if (conversationId <= (settings.config.startAfterConversationId[String(accountId)] ?? 0)) {
    await complete();
    return;
  }
  if (recorded?.state === "done") {
    await complete(recorded, recorded.kindConfidence >= routing.minConfidence ? recorded.kind : null);
    return;
  }
  if (conversation.assignee && recorded?.state !== "pending") {
    // Assigned by a person or an automation rule: nothing to decide, ever.
    store.set(key, JSON.stringify({ ...(recorded ?? unassignable()), state: "done" }));
    await complete(recorded);
    return;
  }
  // The customer wrote after the messages Jev was given: a decision not applied yet is made again.
  const stale =
    recorded?.state === "pending" && (await wroteSince(chatwoot, accountId, conversationId, recorded.lastMessageId));
  let decision = recorded?.state === "pending" && !stale ? recorded : undefined;
  let current = conversation;
  if (!decision) {
    if (conversation.status !== "open") {
      await complete(recorded?.state === "waiting" ? recorded : undefined);
      return;
    }
    const { text, messages, lastMessageId } = await customerText(chatwoot, accountId, conversationId, [
      conversation.contact?.name,
      conversation.contact?.email,
    ]);
    // Nothing new since the last answer (or no customer message yet): a later message routes it.
    if (!stale && messages <= (recorded?.messages ?? 0)) {
      await complete(recorded, recorded && recorded.kindConfidence >= routing.minConfidence ? recorded.kind : null);
      return;
    }
    decision = await decide(ctx, owners, routing.kinds?.[String(accountId)], text, messages, lastMessageId);
    store.set(key, JSON.stringify(decision));
    // Asking Jev takes a moment: apply the decision to the conversation as it is now.
    const now = await chatwoot.getConversation(accountId, conversationId);
    if (!now) return;
    current = toRelayConversation(conversationId, now);
  }

  const kinds = routing.kinds?.[String(accountId)] ?? {};
  const kindName =
    decision.kind !== null && decision.kindConfidence >= routing.minConfidence && Object.hasOwn(kinds, decision.kind)
      ? decision.kind
      : null;
  const kind = kindName === null ? undefined : kinds[kindName];
  const withKind = (labels: string[]) =>
    kindName === null || labels.includes(kindName) ? labels : [...labels, kindName];
  // Not a ticket someone took meanwhile. A retry finishes what an attempt began: labels and a status
  // set twice change nothing, and a status already set (its answer lost) is not set again.
  if (kind?.status && !current.assignee && (current.status === "open" || current.status === kind.status)) {
    const labels = withKind(current.labels);
    if (labels !== current.labels) await chatwoot.setLabels(accountId, conversationId, labels);
    const replied = await replyOnce(ctx, accountId, conversationId, decision, kind);
    if (current.status !== kind.status) await chatwoot.setStatus(accountId, conversationId, { status: kind.status });
    store.set(handledKey(accountId, conversationId), String(decision.lastMessageId));
    await complete(decision, kindName);
    store.set(key, JSON.stringify({ ...decision, state: "done" }));
    log.info("ticket set aside as its kind", {
      accountId,
      conversationId,
      kind: decision.kind,
      kindConfidence: decision.kindConfidence,
      replied,
      status: kind.status,
    });
    return;
  }
  // Closed meanwhile (and nobody took it): keep the decision pending until it opens again.
  if (current.status !== "open" && !current.assignee) {
    await complete();
    return;
  }
  const owner =
    decision.owner !== null && decision.ownerConfidence >= routing.minConfidence ? owners[decision.owner] : undefined;
  const assign = owner !== undefined && !current.assignee;
  if (assign) await chatwoot.assign(accountId, conversationId, owner.assignee);

  // The topic is a label, and a ticket has one besides its kinds: added when Jev is confident and the
  // ticket has no other label yet (an automation rule's label, such as an inbox's, is kept alone).
  const topic =
    decision.topic !== null &&
    Object.hasOwn(routing.topics ?? {}, decision.topic) &&
    decision.topicConfidence >= routing.minConfidence &&
    current.labels.every((label) => Object.hasOwn(kinds, label))
      ? decision.topic
      : null;
  const labels = withKind(topic === null ? current.labels : [...current.labels, topic]);
  if (labels !== current.labels) await chatwoot.setLabels(accountId, conversationId, labels);

  const replied = kind ? await replyOnce(ctx, accountId, conversationId, decision, kind) : false;

  const final = owner !== undefined || current.assignee != null || decision.messages >= MAX_MESSAGES;
  const state: RoutingState = final ? "done" : "waiting";
  // Snoozed before the state is recorded, so a retry snoozes it again (a no-op when it is). Not
  // when the customer has written since the messages Jev was given: that message's run asks again.
  const snooze =
    state === "waiting" &&
    routing.snoozeUnclear &&
    decision.noRequest &&
    !(await wroteSince(chatwoot, accountId, conversationId, decision.lastMessageId));
  if (snooze) await chatwoot.setStatus(accountId, conversationId, { status: "snoozed" });
  await complete(decision, kindName);
  store.set(key, JSON.stringify({ ...decision, state }));
  log.info("ticket routed", {
    accountId,
    conversationId,
    owner: decision.owner,
    ownerConfidence: decision.ownerConfidence,
    topic: decision.topic,
    topicConfidence: decision.topicConfidence,
    messages: decision.messages,
    assigned: assign,
    topicSet: topic !== null,
    kind: decision.kind,
    kindConfidence: decision.kindConfidence,
    replied,
    noRequest: decision.noRequest,
    snoozed: snooze,
    state,
  });
}

/** Pages of messages (MESSAGE_PAGE_SIZE each) read for a customer's messages. */
const PAGES = 3;

/**
 * Up to `limit` customer messages after message `messageId` (0: from the start), and whether that
 * is all there are: notes and activity lines may come in between, and only PAGES pages of messages
 * are read.
 */
async function customerMessages(
  chatwoot: ChatwootClient,
  accountId: number,
  conversationId: number,
  messageId: number,
  limit: number,
): Promise<{ messages: ChatwootMessage[]; complete: boolean }> {
  const found: ChatwootMessage[] = [];
  let after = messageId;
  for (let page = 0; page < PAGES && found.length < limit; page += 1) {
    const messages = await chatwoot.listMessages(accountId, conversationId, after);
    found.push(...messages.filter((message) => message.message_type === 0 && !message.private));
    const last = messages.at(-1);
    if (!last || messages.length < MESSAGE_PAGE_SIZE) return { messages: found.slice(0, limit), complete: true };
    after = last.id;
  }
  return { messages: found.slice(0, limit), complete: found.length >= limit };
}

/** Whether the customer wrote after message `messageId`; beyond the pages read, taken as yes. */
async function wroteSince(
  chatwoot: ChatwootClient,
  accountId: number,
  conversationId: number,
  messageId: number,
): Promise<boolean> {
  const { messages, complete } = await customerMessages(chatwoot, accountId, conversationId, messageId, 1);
  return messages.length > 0 || !complete;
}

/**
 * The ticket's subject and first customer messages, with identifiers removed, how many messages
 * that is, and the newest of them.
 */
async function customerText(
  chatwoot: ChatwootClient,
  accountId: number,
  conversationId: number,
  identities: Array<string | null | undefined>,
): Promise<{ text: string; messages: number; lastMessageId: number }> {
  const { messages } = await customerMessages(chatwoot, accountId, conversationId, 0, MAX_MESSAGES);
  const subject = messages.map((message) => message.content_attributes?.email?.subject).find(Boolean) ?? "";
  const text = [subject, ...messages.map(messageContent)].filter((part) => part.trim()).join("\n");
  return { text: sanitize(text, identities), messages: messages.length, lastMessageId: messages.at(-1)?.id ?? 0 };
}

export function sanitize(text: string, identities: Array<string | null | undefined>): string {
  let value = text.normalize("NFKC");
  const names = identities.flatMap((identity) => (identity ? [identity, ...identity.split(/\s+/)] : []));
  for (const name of [...new Set(names)].filter((item) => item.length >= 2).sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "giu"), "[REDACTED]");
  }
  for (const pattern of REDACTIONS) value = value.replace(pattern, "[REDACTED]");
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

type Owners = NonNullable<Settings["config"]["routing"]>["accounts"][string];

type Kinds = NonNullable<NonNullable<Settings["config"]["routing"]>["kinds"]>[string];
type Kind = Kinds[string];

async function decide(
  ctx: RoutingContext,
  owners: Owners,
  kinds: Kinds | undefined,
  text: string,
  messages: number,
  lastMessageId: number,
): Promise<Decision> {
  const routing = ctx.settings.config.routing;
  const apiKey = ctx.settings.secrets.TYPESAFE_API_KEY;
  if (!routing || !apiKey) throw new JevError("routing is not configured");
  const ownerCriteria: Record<string, string> = Object.fromEntries(
    Object.entries(owners).map(([route, owner]) => [route, owner.covers]),
  );
  ownerCriteria[UNCLEAR] = UNCLEAR_CRITERION;
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {
    owner: {
      type: "choice",
      instructions: "Select who should handle this support ticket, using only the ticket.",
      criteria: ownerCriteria,
    },
  };
  if (routing.topics) {
    questions.topic = {
      type: "choice",
      instructions: "Select the topic of this support ticket, using only the ticket.",
      criteria: routing.topics,
    };
  }
  if (routing.snoozeUnclear) {
    questions.request = {
      type: "choice",
      instructions: "Select whether the customer asks for anything in this support ticket, using only the ticket.",
      criteria: REQUEST_CRITERIA,
    };
  }
  if (kinds) {
    questions.kind = {
      type: "choice",
      instructions: "Select the kind of this support ticket, using only the ticket.",
      criteria: {
        ...Object.fromEntries(Object.entries(kinds).map(([name, kind]) => [name, kind.covers])),
        [NO_KIND]: NO_KIND_CRITERION,
      },
    };
  }

  // A redirect is an error, never followed: it could carry the key to another host.
  const response = await ctx.fetch(
    new Request(JEV_URL, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: routing.model, state: { ticket: text }, questions }),
    }),
  );
  if (!response.ok) throw new JevError(`HTTP ${response.status}`);
  const parsed = jevResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new JevError("invalid response");

  const answer = (question: string): { choice: string | null; confidence: number } => {
    const criteria = questions[question]?.criteria;
    if (!criteria) return { choice: null, confidence: 0 };
    const given = parsed.data.answers[question];
    if (!given || !Object.hasOwn(criteria, given.choice)) throw new JevError(`no valid ${question}`);
    return { choice: given.choice, confidence: given.probabilities?.[given.choice] ?? given.confidence ?? 0 };
  };
  const owner = answer("owner");
  const topic = answer("topic");
  const kind = answer("kind");
  const request = answer("request");
  return {
    owner: owner.choice === UNCLEAR ? null : owner.choice,
    ownerConfidence: owner.confidence,
    topic: topic.choice,
    topicConfidence: topic.confidence,
    kind: kind.choice === NO_KIND ? null : kind.choice,
    kindConfidence: kind.confidence,
    noRequest: request.choice === "none" && request.confidence >= routing.minConfidence,
    messages,
    lastMessageId,
    state: "pending",
  };
}

function unassignable(): Decision {
  return {
    owner: null,
    ownerConfidence: 0,
    topic: null,
    topicConfidence: 0,
    kind: null,
    kindConfidence: 0,
    noRequest: false,
    messages: 0,
    lastMessageId: 0,
    state: "done",
  };
}

function readDecision(stored: string | undefined): Decision | undefined {
  if (stored === undefined) return undefined;
  try {
    const parsed = decisionSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
