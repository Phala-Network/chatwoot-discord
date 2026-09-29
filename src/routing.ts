// Routing: when `routing` is configured for an account, a new ticket gets its owner assigned and
// its topic set by TypeSafe Jev (https://docs.typesafe.ai), a classifier that answers a multiple
// choice question with a probability per option.
//
// A ticket is routed once: when it is open, unassigned, and has a customer message. Jev sees the
// subject and the first customer messages, with identifiers (emails, URLs, addresses, keys, phone
// numbers, IP addresses, handles, and the contact's name) removed. An answer below
// `minConfidence`, or "unclear", changes nothing: the ticket stays for a person. Jev's decision
// is recorded before it is applied, so a retry applies the same decision and asks Jev only once;
// once applied, the ticket is never routed again, even if someone unassigns it.

import { z } from "zod";
import { type ChatwootClient, type Fetch, messageContent, toRelayConversation } from "./chatwoot/api.ts";
import type { Settings } from "./config.ts";
import { log } from "./log.ts";

/** Jev's answer when no owner fits; also the reserved route name. */
export const UNCLEAR = "unclear";
const UNCLEAR_CRITERION =
  "The message has no concrete request, mixes several of the other areas, concerns another product, or cannot be " +
  "assigned to exactly one of them.";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const DECISION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 3;
const MAX_TEXT = 1600;

const REDACTIONS = [
  /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}(?!\w)/gi, // email
  /\b(?:https?|ftp):\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi, // URL
  /\b(?:0x)?[0-9a-f]{20,}\b/gi, // hex ids, EVM addresses, hashes
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,64}(?![1-9A-HJ-NP-Za-km-z])/g, // base58 addresses
  /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{40,}(?![A-Za-z0-9_+/=-])/g, // keys and tokens
  /(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g, // phone numbers
  /(?<!\w)(?:\d{1,3}\.){3}\d{1,3}(?!\w)/g, // IPv4
  /(?<!\w)@[A-Za-z0-9_.-]{2,}/g, // handles
];

export interface RoutingStore {
  get(key: string): string | undefined;
  set(key: string, value: string, ttlMs?: number): void;
}

export interface RoutingContext {
  settings: Settings;
  store: RoutingStore;
  chatwoot: ChatwootClient;
  /** Counts toward the invocation's subrequest budget, like the Chatwoot client's. */
  fetch: Fetch;
}

const decisionSchema = z.object({
  owner: z.string().nullable(),
  ownerConfidence: z.number(),
  topic: z.string().nullable(),
  topicConfidence: z.number(),
  applied: z.boolean(),
});
type Decision = z.infer<typeof decisionSchema>;

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

export class JevError extends Error {
  constructor(detail: string) {
    super(`TypeSafe Jev: ${detail}`);
    this.name = "JevError";
  }
}

export function routingKey(accountId: number, conversationId: number): string {
  return `route:${accountId}:${conversationId}`;
}

/** Whether routing is configured for the account. */
export function routesAccount(settings: Settings, accountId: number): boolean {
  return settings.config.routing?.accounts[String(accountId)] !== undefined;
}

/** Whether a listed conversation may still need routing (open, unassigned, not routed yet). */
export function awaitsRouting(
  settings: Settings,
  store: RoutingStore,
  accountId: number,
  conversation: { id?: number; status?: string; meta?: { assignee?: unknown } | null },
): boolean {
  return (
    routesAccount(settings, accountId) &&
    conversation.id !== undefined &&
    conversation.status === "open" &&
    !conversation.meta?.assignee &&
    !readDecision(store.get(routingKey(accountId, conversation.id)))?.applied
  );
}

export async function routeConversation(ctx: RoutingContext, accountId: number, conversationId: number): Promise<void> {
  const { settings, store, chatwoot } = ctx;
  const routing = settings.config.routing;
  const owners = routing?.accounts[String(accountId)];
  if (!routing || !owners) return;
  const key = routingKey(accountId, conversationId);
  const recorded = readDecision(store.get(key));
  if (recorded?.applied) return;

  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) return;
  const conversation = toRelayConversation(conversationId, raw);
  let decision = recorded;
  if (!decision) {
    if (conversation.assignee) {
      // Assigned by a person or an automation rule first: nothing to decide, ever.
      store.set(key, JSON.stringify(skipped()), DECISION_TTL_MS);
      return;
    }
    if (conversation.status !== "open") return; // Routed if it opens again unassigned.
    const text = await customerText(chatwoot, accountId, conversationId, [
      conversation.contact?.name,
      conversation.contact?.email,
    ]);
    if (!text) return; // No customer message yet: its message_created webhook routes it.
    decision = await decide(ctx, owners, text);
    store.set(key, JSON.stringify(decision), DECISION_TTL_MS);
  }

  const owner =
    decision.owner !== null && decision.ownerConfidence >= routing.minConfidence ? owners[decision.owner] : undefined;
  const assign = owner !== undefined && conversation.status === "open" && !conversation.assignee;
  if (assign) await chatwoot.assign(accountId, conversationId, owner.assignee);

  const topicAttribute = settings.config.relay.topicAttribute;
  const topic =
    decision.topicConfidence >= routing.minConfidence && !conversation.customAttributes[topicAttribute]
      ? decision.topic
      : null;
  if (topic !== null) await chatwoot.setCustomAttribute(accountId, conversationId, topicAttribute, topic);

  store.set(key, JSON.stringify({ ...decision, applied: true }), DECISION_TTL_MS);
  log.info("ticket routed", {
    accountId,
    conversationId,
    owner: decision.owner,
    ownerConfidence: decision.ownerConfidence,
    topic: decision.topic,
    topicConfidence: decision.topicConfidence,
    assigned: assign,
    topicSet: topic !== null,
  });
}

/** The ticket's subject and first customer messages, with identifiers removed; "" when there are none. */
async function customerText(
  chatwoot: ChatwootClient,
  accountId: number,
  conversationId: number,
  identities: Array<string | null | undefined>,
): Promise<string> {
  const messages = (await chatwoot.listMessages(accountId, conversationId))
    .filter((message) => message.message_type === 0 && !message.private)
    .slice(0, MAX_MESSAGES);
  const subject = messages.map((message) => message.content_attributes?.email?.subject).find(Boolean) ?? "";
  const text = [subject, ...messages.map(messageContent)].filter((part) => part.trim()).join("\n");
  return sanitize(text, identities);
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

async function decide(ctx: RoutingContext, owners: Owners, text: string): Promise<Decision> {
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
  return {
    owner: owner.choice === UNCLEAR ? null : owner.choice,
    ownerConfidence: owner.confidence,
    topic: topic.choice,
    topicConfidence: topic.confidence,
    applied: false,
  };
}

function skipped(): Decision {
  return { owner: null, ownerConfidence: 0, topic: null, topicConfidence: 0, applied: true };
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
