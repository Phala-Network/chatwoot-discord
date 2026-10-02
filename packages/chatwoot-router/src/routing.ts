// Reconcile observations against a memoized decision; publish attributes after actions.
// Irreversible actions are recorded before sending. See README.md, "How it works".

import ipRegex from "ip-regex";
import { z } from "zod";
import { messageWatermark, ROUTING_ATTRIBUTES } from "../../../shared/attributes.ts";
import {
  type ChatwootClient,
  type ChatwootConversation,
  type ChatwootMessage,
  chatwootClient,
  type Fetch,
  MESSAGE_PAGE_SIZE,
  messageContent,
  toRelayConversation,
} from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import type { Settings } from "./config.ts";
import { actOnce, readEffects } from "./effects.ts";

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
  list(prefix: string): string[];
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
  /** Jev is confident the customer asked for nothing yet (asked with `snoozeUnclear` only). */
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

export async function routeConversation(ctx: RoutingContext, accountId: number, conversationId: number): Promise<void> {
  const { settings, store, chatwoot } = ctx;
  const routing = settings.config.routing;
  const owners = routing.accounts[String(accountId)];
  if (!owners) return;
  const kinds = routing.kinds?.[String(accountId)] ?? {};
  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) return;
  const conversation = toRelayConversation(conversationId, raw);
  const latest = await chatwoot.listMessages(accountId, conversationId, { filter_internal_messages: true });
  const inputs = await customerInputs(ctx, accountId, conversationId, [
    conversation.contact?.name,
    conversation.contact?.email,
  ]);
  const seen = Math.max(inputs.seen, ...latest.filter(isCustomer).map((message) => message.id));
  const key = inputs.ids.join(",");
  const memoKey = `decision:${accountId}:${conversationId}:${key}`;
  const cached = inputs.ids.map((_, index) =>
    readDecision(store.get(`decision:${accountId}:${conversationId}:${inputs.ids.slice(0, index + 1).join(",")}`)),
  );
  let decision = cached.at(-1);
  const previous = cached.findLast((entry) => entry !== undefined);
  const kindFor = (answer?: Decision) =>
    answer?.kind && answer.kindConfidence >= routing.minConfidence ? kinds[answer.kind] : undefined;
  const assigneeFor = (answer?: Decision) =>
    answer?.owner && answer.ownerConfidence >= routing.minConfidence ? owners[answer.owner]?.assignee : undefined;
  const eligible = (observed: typeof conversation, answer?: Decision) =>
    conversationId > (settings.config.startAfterConversationId[String(accountId)] ?? 0) &&
    !observed.contact?.blocked &&
    observed.status === "open" &&
    (!observed.assignee || observed.assignee.id === assigneeFor(answer));
  let observed = raw;
  if (inputs.ids.length > 0 && eligible(conversation, previous)) {
    if (!decision) {
      decision = await decide(ctx, owners, routing.kinds?.[String(accountId)], inputs.text);
      store.set(memoKey, JSON.stringify(decision));
    }
    const fresh = await chatwoot.getConversation(accountId, conversationId);
    if (!fresh) return;
    observed = fresh;
    const current = toRelayConversation(conversationId, fresh);
    if (eligible(current, decision)) {
      const kind = kindFor(decision);
      const kindName = kind ? decision.kind : null;
      const assignee = kind?.status ? undefined : assigneeFor(decision);
      if (assignee !== undefined && !current.assignee) await chatwoot.assign(accountId, conversationId, assignee);
      const topic =
        !kind?.status &&
        decision.topic !== null &&
        Object.hasOwn(routing.topics ?? {}, decision.topic) &&
        decision.topicConfidence >= routing.minConfidence &&
        current.labels.every((label) => Object.hasOwn(kinds, label))
          ? decision.topic
          : null;
      const labels = [...new Set([...current.labels, ...[topic, kindName].filter((label) => label !== null)])];
      if (labels.length !== current.labels.length) await chatwoot.setLabels(accountId, conversationId, labels);
      observed = { ...fresh, labels };
      const lastInput = inputs.ids.at(-1) ?? 0;
      const replyKey = `reply:${accountId}:${conversationId}`;
      const botToken = settings.botToken(accountId);
      if (kind?.cannedResponse && botToken && store.get(replyKey) === undefined) {
        const content = await chatwoot.cannedResponse(accountId, kind.cannedResponse);
        if (content === undefined) throw new Error("Chatwoot canned response is missing");
        const bot = chatwootClient(settings.config.chatwoot.baseUrl, botToken, ctx.fetch);
        await actOnce(ctx, replyKey, kindName, lastInput, () =>
          bot.createMessage(accountId, conversationId, { content, private: false, files: [] }),
        );
      }
      const snooze = !assignee && inputs.ids.length < MAX_MESSAGES && routing.snoozeUnclear && decision.noRequest;
      const status = inputs.complete ? (kind?.status ?? (snooze ? "snoozed" : undefined)) : undefined;
      if (status) {
        await actOnce(ctx, `status:${accountId}:${conversationId}:${key}`, kindName, kind?.status ? lastInput : 0, () =>
          chatwoot.setStatus(accountId, conversationId, { status }),
        );
      }
    }
  }
  const effects = readEffects(store, accountId, conversationId);
  const labels = observed.labels ?? [];
  const kind =
    [decision, ...cached.toReversed()].find((answer) => answer?.kind && kindFor(answer) && labels.includes(answer.kind))
      ?.kind ??
    effects.findLast((effect) => effect.kind !== null)?.kind ??
    null;
  await syncAttributes(
    ctx,
    accountId,
    conversationId,
    observed,
    seen,
    Math.max(0, ...effects.map((effect) => effect.handled)),
    kind,
  );
}

async function syncAttributes(
  ctx: RoutingContext,
  accountId: number,
  conversationId: number,
  observed: ChatwootConversation,
  seen: number,
  handled: number,
  kind: string | null,
): Promise<void> {
  const current = observed.custom_attributes ?? {};
  const names = ROUTING_ATTRIBUTES;
  const attributes = {
    [names.seen]: Math.max(seen, messageWatermark(current[names.seen])),
    ...(handled > 0 ? { [names.handled]: Math.max(handled, messageWatermark(current[names.handled])) } : {}),
    ...(kind === null ? {} : { [names.kind]: kind }),
  };
  if (
    Object.entries(attributes).some(
      ([name, value]) => (name === names.kind ? current[name] : messageWatermark(current[name])) !== value,
    )
  )
    await ctx.chatwoot.setCustomAttributes(accountId, conversationId, attributes);
}

function isCustomer(message: ChatwootMessage): boolean {
  return message.message_type === 0 && !message.private;
}

async function customerInputs(
  ctx: RoutingContext,
  accountId: number,
  conversationId: number,
  identities: Array<string | null | undefined>,
) {
  const ids: number[] = [];
  const parts: string[] = [];
  let after = 0;
  let seen = 0;
  let complete = false;
  for (let page = 0; page < 3 && ids.length < MAX_MESSAGES; page += 1) {
    const messages = await ctx.chatwoot.listMessages(accountId, conversationId, {
      after,
      filter_internal_messages: true,
    });
    for (const message of messages.filter(isCustomer)) {
      seen = Math.max(seen, message.id);
      const text = sanitize(
        [message.content_attributes?.email?.subject ?? "", messageContent(message)].join("\n"),
        identities,
      );
      if (ids.length < MAX_MESSAGES && text.replaceAll("[REDACTED]", "").trim()) {
        ids.push(message.id);
        parts.push(text);
      }
    }
    complete = ids.length === MAX_MESSAGES || messages.length < MESSAGE_PAGE_SIZE;
    if (complete) break;
    after = messages.at(-1)?.id ?? after;
  }
  return { ids, text: parts.join(" ").slice(0, MAX_TEXT), complete, seen };
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
  };
}

function readDecision(stored: string | undefined): Decision | undefined {
  const parsed = decisionSchema.safeParse(parseJson(stored));
  return parsed.success ? parsed.data : undefined;
}
