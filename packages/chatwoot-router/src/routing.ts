// Route only the native bot turn. See README.md, "How it works".

import ipRegex from "ip-regex";
import { z } from "zod";
import {
  type ChatwootClient,
  type ChatwootMessage,
  chatwootClient,
  type Fetch,
  messageContent,
  toRelayConversation,
} from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import type { Settings } from "./config.ts";
import { expectActivity, readTurn, requestHandoff } from "./turn.ts";

/** Jev's answer when no owner fits; also the reserved route name. */
export const UNCLEAR = "unclear";
const UNCLEAR_CRITERION =
  "The message has no concrete request, mixes several of the other areas, concerns another product, or cannot be " +
  "assigned to exactly one of them.";
/** Whether the customer asked for anything yet. */
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

const decisionSchema = z.object({
  owner: z.string().nullable(),
  ownerConfidence: z.number(),
  topic: z.string().nullable(),
  topicConfidence: z.number(),
  kind: z.string().nullable().default(null),
  kindConfidence: z.number().default(0),
  /** Jev is confident the customer asked for nothing yet. */
  noRequest: z.boolean().default(false),
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

class JevError extends Error {
  constructor(detail: string) {
    super(`TypeSafe Jev: ${detail}`);
    this.name = "JevError";
  }
}

export function routesAccount(settings: Settings, accountId: number): boolean {
  return settings.config.routing.accounts[String(accountId)] !== undefined;
}

export async function routeConversation(
  ctx: RoutingContext,
  accountId: number,
  conversationId: number,
): Promise<"defer" | undefined> {
  const { settings, store, chatwoot } = ctx;
  const routing = settings.config.routing;
  const owners = routing.accounts[String(accountId)];
  const token = settings.botToken(accountId);
  if (!owners || !token) return;
  const bot = chatwootClient(settings.config.chatwoot.baseUrl, token, ctx.fetch);
  const kinds = routing.kinds?.[String(accountId)] ?? {};
  const botId = routing.botIds[String(accountId)];
  const snapshot = async (inboxId?: number) => {
    const raw = await chatwoot.getConversation(accountId, conversationId);
    if (!raw || raw.inbox_id === undefined || (inboxId !== undefined && raw.inbox_id !== inboxId)) return;
    if (raw.status !== "pending") {
      // Only an action read observed pending end. updated_at also changes for metadata.
      if (inboxId !== undefined) expectActivity(store, accountId, conversationId, { status: raw.status ?? "open" });
      return;
    }
    const conversation = toRelayConversation(conversationId, raw);
    if (conversation.contact.blocked || conversation.assignee) return;
    if (raw.meta?.assignee && (raw.meta.assignee_type !== "AgentBot" || raw.meta.assignee.id !== botId)) return;
    if ((await chatwoot.inboxBot(accountId, raw.inbox_id))?.id !== botId) return;
    return { raw, conversation };
  };
  const initial = await snapshot();
  if (!initial) return;
  const identities = [initial.conversation.contact.name, initial.conversation.contact.email];
  const inputs = (messages: ChatwootMessage[]) => {
    const texts = messages
      .filter(isCustomer)
      .flatMap((message) => {
        const text = sanitize(
          [message.content_attributes?.email?.subject ?? "", messageContent(message)].join("\n"),
          identities,
        );
        return text.replaceAll("[REDACTED]", "").trim() ? [{ id: message.id, text }] : [];
      })
      .slice(0, MAX_MESSAGES);
    return {
      key: texts.map((entry) => entry.id).join(","),
      text: texts
        .map((entry) => entry.text)
        .join(" ")
        .slice(0, MAX_TEXT),
      count: texts.length,
    };
  };
  const turn = await readTurn(chatwoot, store, accountId, conversationId);
  const input = inputs(turn.messages);
  const humanReply = (messages: ChatwootMessage[]) =>
    messages.some(
      (message) =>
        message.message_type === 1 &&
        !message.private &&
        message.sender?.type === "user" &&
        !message.content_attributes?.deleted,
    );

  // A fresh read before every effect. A new input/boundary is work for a new queue run.
  const fresh = async () => {
    const current = await snapshot(initial.raw.inbox_id);
    if (!current) return;
    const latest = await readTurn(chatwoot, store, accountId, conversationId);
    if (latest.boundary !== turn.boundary || inputs(latest.messages).key !== input.key) return "defer" as const;
    return { ...current, handoff: latest.handoff || humanReply(latest.messages) };
  };
  const handoff = async () => {
    requestHandoff(store, accountId, conversationId);
    const current = await fresh();
    if (current === "defer") return "defer" as const;
    if (current) await bot.setStatus(accountId, conversationId, { status: "open" });
    return undefined;
  };
  if (turn.handoff || humanReply(turn.messages) || input.count === 0) return handoff();
  const memoKey = `decision:${accountId}:${conversationId}:${input.key}`;
  let decision = readDecision(store.get(memoKey));
  if (!decision) {
    decision = await decide(ctx, owners, routing.kinds?.[String(accountId)], input.text);
    store.set(memoKey, JSON.stringify(decision));
  }
  const kind = decision.kind && decision.kindConfidence >= routing.minConfidence ? kinds[decision.kind] : undefined;
  // A kind is actionable even when its text happens to look like a greeting.
  const assignee =
    decision.owner && decision.ownerConfidence >= routing.minConfidence ? owners[decision.owner]?.assignee : undefined;
  let current = await fresh();
  if (current === "defer" || !current) return current;
  if (current.handoff) return handoff();
  if (!kind && decision.noRequest && input.count < MAX_MESSAGES) return;
  const topic =
    !kind?.status &&
    decision.topic !== null &&
    Object.hasOwn(routing.topics ?? {}, decision.topic) &&
    decision.topicConfidence >= routing.minConfidence &&
    current.conversation.labels.every((label) => Object.hasOwn(kinds, label))
      ? decision.topic
      : null;
  const labels = [
    ...new Set([
      ...current.conversation.labels,
      ...[topic, kind ? decision.kind : null].filter((label) => label !== null),
    ]),
  ];
  if (labels.length !== current.conversation.labels.length) await bot.setLabels(accountId, conversationId, labels);
  const replyKey = `reply:${accountId}:${conversationId}`;
  if (kind?.cannedResponse && store.get(replyKey) === undefined) {
    const content = await chatwoot.cannedResponse(accountId, kind.cannedResponse);
    if (!content?.trim()) return handoff();
    current = await fresh();
    if (current === "defer" || !current) return current;
    if (current.handoff) return handoff();
    store.set(replyKey, "attempted");
    await bot.createMessage(accountId, conversationId, { content, private: false, files: [] });
  }
  if (assignee !== undefined && !kind?.status) {
    // AssignmentService silently assigns nobody for a user outside this account.
    const agents = await chatwoot.listAgents(accountId);
    if (!agents.some((agent) => agent.id === assignee)) return handoff();
  }
  current = await fresh();
  if (current === "defer" || !current) return current;
  if (current.handoff) return handoff();
  if (kind?.status) {
    const at = Date.now() / 1000;
    await bot.setStatus(accountId, conversationId, { status: kind.status });
    expectActivity(store, accountId, conversationId, { status: kind.status, at });
  } else if (assignee !== undefined && current.raw.meta?.assignee_type === "AgentBot") {
    const at = Date.now() / 1000;
    await bot.assign(accountId, conversationId, assignee);
    expectActivity(store, accountId, conversationId, { status: "open", at });
  } else {
    return handoff();
  }
  // Assignment itself ends a bot-assigned turn. No reply or status action may follow it.
  return undefined;
}

function isCustomer(message: ChatwootMessage): boolean {
  return (
    message.message_type === 0 &&
    !message.private &&
    !message.content_attributes?.deleted &&
    !message.content_attributes?.email?.auto_reply &&
    (message.sender?.type == null || message.sender.type === "contact")
  );
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

async function decide(ctx: RoutingContext, owners: Owners, kinds: Kinds | undefined, text: string): Promise<Decision> {
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
  questions.request = {
    type: "choice",
    instructions: "Select whether the customer asks for anything in this support ticket, using only the ticket.",
    criteria: REQUEST_CRITERIA,
  };
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
  };
}

function readDecision(stored: string | undefined): Decision | undefined {
  const parsed = decisionSchema.safeParse(parseJson(stored));
  return parsed.success ? parsed.data : undefined;
}
