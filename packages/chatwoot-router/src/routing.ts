// Record decisions before applying them; publish completion only afterward.
// Recheck customer activity and human changes before acting. Replies are attempted at most once.

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
import { parseJson } from "../../../shared/json.ts";
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
  textAfter: z.number().int().min(0).optional(),
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
  if (
    conversation.contact?.blocked ||
    conversationId <= (settings.config.startAfterConversationId[String(accountId)] ?? 0)
  ) {
    await complete();
    return;
  }
  if (recorded?.state === "done") {
    await complete(recorded, recorded.kindConfidence >= routing.minConfidence ? recorded.kind : null);
    return;
  }
  if (conversation.status !== "open" || conversation.assignee) {
    await complete(recorded);
    return;
  }
  // The customer wrote after the messages Jev was given: a decision not applied yet is made again.
  let activity =
    recorded?.state === "pending"
      ? await customerMessages(chatwoot, accountId, conversationId, recorded.lastMessageId, 1)
      : undefined;
  const stale = recorded?.state === "pending" && (activity?.messages.length ?? 0) > 0;
  let decision = recorded?.state === "pending" && !stale ? recorded : undefined;
  if (!decision) {
    const after = stale && recorded.messages >= MAX_MESSAGES ? recorded.lastMessageId : (recorded?.textAfter ?? 0);
    const { text, messages, lastMessageId } = await customerText(
      chatwoot,
      accountId,
      conversationId,
      [conversation.contact?.name, conversation.contact?.email],
      after,
    );
    // Nothing new since the last answer (or no customer message yet): a later message routes it.
    if (!stale && messages <= (recorded?.messages ?? 0)) {
      await complete(recorded, recorded && recorded.kindConfidence >= routing.minConfidence ? recorded.kind : null);
      return;
    }
    if (!text.replaceAll("[REDACTED]", "").trim()) {
      decision = {
        owner: null,
        ownerConfidence: 0,
        topic: null,
        topicConfidence: 0,
        kind: null,
        kindConfidence: 0,
        noRequest: false,
        messages: 0,
        lastMessageId,
        textAfter: lastMessageId,
        state: "waiting",
      };
      store.set(key, JSON.stringify(decision));
      await complete(decision);
      return;
    }
    decision = {
      ...(await decide(ctx, owners, routing.kinds?.[String(accountId)], text, messages, lastMessageId)),
      textAfter: after,
    };
    store.set(key, JSON.stringify(decision));
    activity = undefined;
  }

  const kinds = routing.kinds?.[String(accountId)] ?? {};
  const kindName =
    decision.kind !== null && decision.kindConfidence >= routing.minConfidence && Object.hasOwn(kinds, decision.kind)
      ? decision.kind
      : null;
  const kind = kindName === null ? undefined : kinds[kindName];
  const owner =
    decision.owner !== null && decision.ownerConfidence >= routing.minConfidence ? owners[decision.owner] : undefined;
  const final = kind?.status !== undefined || owner !== undefined || decision.messages >= MAX_MESSAGES;
  const snooze = !final && routing.snoozeUnclear && decision.noRequest;
  if ((kind !== undefined || snooze) && !activity) {
    activity = await customerMessages(chatwoot, accountId, conversationId, Math.max(seen, decision.lastMessageId), 1);
  }
  const now = await chatwoot.getConversation(accountId, conversationId);
  if (!now) return;
  const current = toRelayConversation(conversationId, now);
  if (current.status !== "open" || current.assignee || current.contact?.blocked) {
    await complete();
    return;
  }
  if (activity?.messages.length) return;
  const state: RoutingState = final || activity?.complete === false ? "done" : "waiting";
  const status = activity?.complete === false ? undefined : (kind?.status ?? (snooze ? "snoozed" : undefined));
  const withKind = (labels: string[]) =>
    kindName === null || labels.includes(kindName) ? labels : [...labels, kindName];
  const assign = owner !== undefined && !kind?.status;
  if (assign) await chatwoot.assign(accountId, conversationId, owner.assignee);

  // The topic is a label, and a ticket has one besides its kinds: added when Jev is confident and the
  // ticket has no other label yet (an automation rule's label, such as an inbox's, is kept alone).
  const topic =
    !kind?.status &&
    decision.topic !== null &&
    Object.hasOwn(routing.topics ?? {}, decision.topic) &&
    decision.topicConfidence >= routing.minConfidence &&
    current.labels.every((label) => Object.hasOwn(kinds, label))
      ? decision.topic
      : null;
  const labels = withKind(topic === null ? current.labels : [...current.labels, topic]);
  if (labels !== current.labels) await chatwoot.setLabels(accountId, conversationId, labels);

  const replied = kind ? await replyOnce(ctx, accountId, conversationId, decision, kind) : false;

  if (status) {
    await chatwoot.setStatus(accountId, conversationId, { status });
    if (kind?.status) store.set(handledKey(accountId, conversationId), String(decision.lastMessageId));
  }
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
    status,
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

/**
 * The ticket's subject and first customer messages, with identifiers removed, how many messages
 * that is, and the newest of them.
 */
async function customerText(
  chatwoot: ChatwootClient,
  accountId: number,
  conversationId: number,
  identities: Array<string | null | undefined>,
  after: number,
): Promise<{ text: string; messages: number; lastMessageId: number }> {
  const { messages } = await customerMessages(chatwoot, accountId, conversationId, after, MAX_MESSAGES);
  const subject = messages.map((message) => message.content_attributes?.email?.subject).find(Boolean) ?? "";
  const text = [subject, ...messages.map(messageContent)].filter((part) => part.trim()).join("\n");
  return { text: sanitize(text, identities), messages: messages.length, lastMessageId: messages.at(-1)?.id ?? 0 };
}

export function sanitize(text: string, identities: Array<string | null | undefined>): string {
  let value = text.normalize("NFKC");
  for (const pattern of REDACTIONS) value = value.replace(pattern, "[REDACTED]");
  const names = identities.flatMap((identity) => (identity ? [identity, ...identity.split(/\s+/)] : []));
  for (const name of [...new Set(names)].filter((item) => item.length >= 2).sort((a, b) => b.length - a.length)) {
    const escaped = RegExp.escape(name);
    value = value.replace(new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "giu"), "[REDACTED]");
  }
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

function readDecision(stored: string | undefined): Decision | undefined {
  const parsed = decisionSchema.safeParse(parseJson(stored));
  return parsed.success ? parsed.data : undefined;
}
