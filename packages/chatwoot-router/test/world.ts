import { type ChatwootMessage, chatwootClient } from "../../../shared/chatwoot/api.ts";
import type { RoutingStore } from "../src/routing.ts";
import { json, mockFetch, on, type Recorded, testSettings } from "./helpers.ts";

export const ROUTING = {
  botIds: { "1": 1 },
  accounts: {
    "1": { cloud: { assignee: 6, covers: "Cloud support and billing." }, sales: { assignee: 7, covers: "Sales." } },
  },
  topics: { billing: "Payments and invoices.", support: "Product support." },
};
export const KINDS = {
  ...ROUTING,
  kinds: {
    "1": {
      startup: { covers: "An application.", cannedResponse: "startup" },
      security: { covers: "Security report.", cannedResponse: "missing" },
      spam: { covers: "Spam.", status: "resolved" },
      newsletter: { covers: "Newsletter.", status: "snoozed" },
      bounty: { covers: "Templated security report.", cannedResponse: "security", status: "resolved" },
    },
  },
};
export const CW = "chatwoot.example.com/api/v1/accounts/1/conversations/5";
export const JEV = "api.typesafe.ai/v1/systemone";
export const incoming = (id: number, content = "Please help with my invoice"): ChatwootMessage => ({
  id,
  content,
  message_type: 0,
  sender: { type: "contact" },
});
export const activity = (id: number, status = "resolved"): ChatwootMessage => ({
  id,
  message_type: 2,
  created_at: Math.floor(Date.now() / 1000),
  content_attributes: { activity: { type: "conversation_status_changed", status } },
});

export class MemoryStore implements RoutingStore {
  values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
}
export function context(store = new MemoryStore(), routing: object = ROUTING) {
  const settings = testSettings({ routing });
  const fetch = (request: Request) => globalThis.fetch(request);
  return { settings, store, chatwoot: chatwootClient(settings.config.chatwoot.baseUrl, "user-token", fetch), fetch };
}
export const sent = (requests: Recorded[], method: string, path: string) =>
  requests.filter((request) => request.method === method && `${request.url.hostname}${request.url.pathname}` === path);

export interface Ticket {
  status?: string;
  updatedAt?: number;
  assignee?: { id: number; name?: string } | null;
  assigneeType?: string | null;
  blocked?: boolean;
  agents?: number[];
  name?: string;
  labels?: string[];
  messages?: ChatwootMessage[];
  bot?: { id: number; account_id: number } | null;
  /** Fail before the action, or lose its response after Chatwoot applied it. */
  fail?: Record<string, number>;
  lose?: Record<string, number>;
  during?: (operation: string) => void;
}
export interface Answers {
  owner: [string, number];
  topic?: [string, number];
  kind?: [string, number];
  request?: [string, number];
}
export function world(ticket: Ticket = {}, answers: Answers = { owner: ["cloud", 1] }, endpoint = JEV) {
  ticket.status ??= "pending";
  if (ticket.assigneeType === undefined) ticket.assigneeType = "AgentBot";
  if (ticket.assignee === undefined) ticket.assignee = { id: 1 };
  ticket.messages ??= [incoming(1)];
  ticket.labels ??= [];
  const fail = (operation: string, after = false) => {
    const counts = after ? ticket.lose : ticket.fail;
    if ((counts?.[operation] ?? 0) <= 0) return false;
    if (counts) counts[operation] = (counts[operation] ?? 0) - 1;
    return true;
  };
  const mutation = (operation: string, apply: (request: Recorded) => unknown) =>
    on("POST", `${CW}/${operation}`, (request) => {
      if (fail(operation)) return json({}, { status: 503 });
      const result = apply(request);
      ticket.during?.(operation);
      return json(result ?? {}, { status: fail(operation, true) ? 503 : 200 });
    });
  return {
    ticket,
    answers,
    ...mockFetch(
      on("GET", "chatwoot.example.com/api/v1/accounts/1/agents", () =>
        json((ticket.agents ?? [6, 7]).map((id) => ({ id }))),
      ),
      on("GET", CW, () => {
        ticket.during?.("read");
        return fail("read")
          ? json({}, { status: 503 })
          : json({
              id: 5,
              inbox_id: 2,
              status: ticket.status,
              updated_at: ticket.updatedAt,
              labels: ticket.labels,
              meta: {
                assignee: ticket.assignee,
                assignee_type: ticket.assigneeType,
                sender: { name: ticket.name ?? "Jane Doe", email: "jane@example.com", blocked: ticket.blocked },
              },
            });
      }),
      on("GET", "chatwoot.example.com/api/v1/accounts/1/inboxes/2/agent_bot", () =>
        json({ agent_bot: ticket.bot === undefined ? { id: 1, account_id: 1 } : ticket.bot }),
      ),
      on("GET", `${CW}/messages`, (request) => {
        ticket.during?.("read-messages");
        if (fail("messages-read")) return json({}, { status: 503 });
        const before = Number(request.url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
        return json({ payload: (ticket.messages ?? []).filter((message) => message.id < before).slice(-20) });
      }),
      on("GET", "chatwoot.example.com/api/v1/accounts/1/canned_responses", () =>
        fail("canned")
          ? json({}, { status: 503 })
          : json([
              { short_code: "startup", content: "Thanks for applying!" },
              { short_code: "security", content: "Contact security@example.com." },
            ]),
      ),
      mutation("labels", (request) => {
        ticket.labels = JSON.parse(request.body).labels;
      }),
      mutation("assignments", (request) => {
        const assigneeId = JSON.parse(request.body).assignee_id;
        if (assigneeId === null) {
          ticket.assignee = null;
          ticket.assigneeType = null;
          return;
        }
        ticket.assignee = { id: assigneeId, name: "Owner" };
        if (ticket.assigneeType === "AgentBot") ticket.status = "open";
        ticket.assigneeType = "User";
        ticket.messages?.push(activity((ticket.messages.at(-1)?.id ?? 0) + 1, "open"));
      }),
      mutation("toggle_status", (request) => {
        ticket.status = JSON.parse(request.body).status;
        if (ticket.status === "open") {
          ticket.assignee = null;
          ticket.assigneeType = null;
        }
        ticket.messages?.push(activity((ticket.messages.at(-1)?.id ?? 0) + 1, ticket.status));
      }),
      mutation("messages", (request) => {
        const message = {
          id: (ticket.messages?.at(-1)?.id ?? 0) + 1,
          conversation_id: 5,
          content: JSON.parse(request.body).content,
          message_type: 1,
          private: false,
          sender: { type: "agent_bot", id: 1 },
        };
        ticket.messages?.push(message);
        return message;
      }),
      on("POST", endpoint, () => {
        if (fail("jev")) return json({}, { status: 503 });
        ticket.during?.("jev");
        return json({
          answers: Object.fromEntries(
            Object.entries({ topic: ["billing", 1], kind: ["none", 1], request: ["request", 1], ...answers }).map(
              ([key, [choice, confidence]]) => [key, { choice, confidence }],
            ),
          ),
        });
      }),
    ),
  };
}
