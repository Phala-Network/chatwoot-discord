import { afterEach, describe, expect, it, vi } from "vitest";
import { chatwootClient } from "../src/chatwoot/api.ts";
import {
  actsAutomatically,
  handledAutomatically,
  type RoutingStore,
  routeConversation,
  sanitize,
} from "../src/routing.ts";
import { json, mockFetch, on, type Recorded, testSettings } from "./helpers.ts";

const ROUTING = {
  accounts: {
    "1": {
      cloud: { assignee: 6, covers: "Cloud support and billing." },
      sales: { assignee: 7, covers: "Sales and GPUs." },
    },
  },
  topics: { "technical-support": "Something does not work.", billing: "Payments and invoices." },
};
const CW = "chatwoot.example.com/api/v1/accounts/1/conversations/5";

class MapStore implements RoutingStore {
  values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
}

interface Ticket {
  assignee?: { id: number; name: string } | null;
  status?: string;
  labels?: string[];
  messages?: Array<{ id: number; content: string; message_type: number; private?: boolean }>;
  /** Snooze requests that fail before Chatwoot answers. */
  failSnooze?: number;
  /** Replies that fail before Chatwoot answers. */
  failReply?: number;
  /** Status changes Chatwoot makes but whose answer is lost. */
  loseStatusAnswer?: number;
}

/** Chatwoot conversation 5 of account 1 and Jev, faked at the fetch boundary. */
function world(
  ticket: Ticket,
  // `request` (asked with snoozeUnclear) defaults to a ticket without one.
  jev: { owner: [string, number]; topic: [string, number]; kind?: [string, number]; request?: [string, number] },
  failAssign = 0,
  whileJevAnswers?: () => void,
) {
  let failures = failAssign;
  const conversation = () => ({
    id: 5,
    status: ticket.status ?? "open",
    inbox_id: 2,
    custom_attributes: {},
    labels: ticket.labels ?? [],
    meta: { sender: { id: 88, name: "Jane Doe", email: "jane@example.com" }, assignee: ticket.assignee ?? null },
    last_non_activity_message: (ticket.messages ?? []).filter((m) => m.message_type <= 1).at(-1) ?? null,
  });
  const mock = mockFetch(
    on("GET", CW, () => json(conversation())),
    on("GET", `${CW}/messages`, (request) => {
      const all = ticket.messages ?? [
        { id: 1, content: "My CVM will not start, says Jane Doe (jane@example.com)", message_type: 0 },
        { id: 2, content: "Looking into it", message_type: 1 },
      ];
      // Chatwoot's MessageFinder: the latest 20 without `after`, else up to 100 after that id.
      const after = request.url.searchParams.get("after");
      const payload = after === null ? all.slice(-20) : all.filter((m) => m.id > Number(after)).slice(0, 100);
      return json({ payload });
    }),
    on("POST", `${CW}/assignments`, () => {
      if (failures > 0) {
        failures -= 1;
        return json({ error: "unavailable" }, { status: 503 });
      }
      return json({});
    }),
    on("POST", `${CW}/labels`, () => json({})),
    on("GET", "chatwoot.example.com/api/v1/accounts/1/canned_responses", () =>
      json([
        { id: 1, short_code: "startup", content: "Hello" },
        { id: 2, short_code: "startup-program", content: "Thanks for applying!" },
        { id: 3, short_code: "security", content: "Please report it to security@example.com." },
      ]),
    ),
    on("POST", `${CW}/messages`, () => {
      if ((ticket.failReply ?? 0) > 0) {
        ticket.failReply = (ticket.failReply ?? 0) - 1;
        return json({ error: "unavailable" }, { status: 503 });
      }
      return json({});
    }),
    on("POST", `${CW}/toggle_status`, (request) => {
      if ((ticket.failSnooze ?? 0) > 0) {
        ticket.failSnooze = (ticket.failSnooze ?? 0) - 1;
        return json({ error: "unavailable" }, { status: 503 });
      }
      ticket.status = JSON.parse(request.body).status;
      if ((ticket.loseStatusAnswer ?? 0) > 0) {
        ticket.loseStatusAnswer = (ticket.loseStatusAnswer ?? 0) - 1;
        return json({ error: "unavailable" }, { status: 503 });
      }
      return json({});
    }),
    on("POST", "api.typesafe.ai/v1/systemone", () => {
      whileJevAnswers?.();
      return json({
        model: "jev-1.13.0",
        answers: {
          owner: { type: "choice", choice: jev.owner[0], probabilities: { [jev.owner[0]]: jev.owner[1] } },
          topic: { type: "choice", choice: jev.topic[0], probabilities: { [jev.topic[0]]: jev.topic[1] } },
          ...(jev.kind
            ? { kind: { type: "choice", choice: jev.kind[0], probabilities: { [jev.kind[0]]: jev.kind[1] } } }
            : {}),
          request: {
            type: "choice",
            choice: (jev.request ?? ["none", 1])[0],
            probabilities: { [(jev.request ?? ["none", 1])[0]]: (jev.request ?? ["none", 1])[1] },
          },
        },
      });
    }),
  );
  return mock;
}

function context(store = new MapStore(), routing: object = ROUTING) {
  const settings = testSettings(
    { routing },
    { TYPESAFE_API_KEY: "ts-key", CHATWOOT_BOT_TOKENS: JSON.stringify({ "1": "bot-token" }) },
  );
  const fetch = (request: Request) => globalThis.fetch(request);
  return { settings, store, chatwoot: chatwootClient(settings.config.chatwoot.baseUrl, "relay-token", fetch), fetch };
}

const sent = (requests: Recorded[], method: string, path: string) =>
  requests.filter((request) => request.method === method && `${request.url.hostname}${request.url.pathname}` === path);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routeConversation", () => {
  it("assigns the owner and adds the topic label Jev is confident about, sending the text without identifiers", async () => {
    const { requests } = world({}, { owner: ["cloud", 0.93], topic: ["technical-support", 0.88] });

    await routeConversation(context(), 1, 5);

    expect(sent(requests, "POST", `${CW}/assignments`).map((r) => JSON.parse(r.body))).toEqual([{ assignee_id: 6 }]);
    expect(sent(requests, "POST", `${CW}/labels`).map((r) => JSON.parse(r.body))).toEqual([
      { labels: ["technical-support"] },
    ]);
    const [jev] = sent(requests, "POST", "api.typesafe.ai/v1/systemone");
    expect(jev?.headers.get("authorization")).toBe("Bearer ts-key");
    expect(jev?.redirect).toBe("manual");
    const body = JSON.parse(jev?.body ?? "{}");
    expect(body.state.ticket).toBe("My CVM will not start, says [REDACTED] ([REDACTED])");
    expect(Object.keys(body.questions.owner.criteria)).toEqual(["cloud", "sales", "unclear"]);
  });

  it("leaves an unclear or doubtful ticket unassigned, and asks again only when the customer adds a message", async () => {
    const store = new MapStore();
    const { requests } = world({}, { owner: ["unclear", 0.9], topic: ["billing", 0.6] });

    await routeConversation(context(store), 1, 5);
    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    expect(sent(requests, "POST", `${CW}/labels`)).toEqual([]);
  });

  it("never routes a ticket someone assigned first, nor adds a second label", async () => {
    const assigned = world({ assignee: { id: 9, name: "Doyle" } }, { owner: ["sales", 1], topic: ["billing", 1] });
    await routeConversation(context(), 1, 5);
    expect(sent(assigned.requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
    vi.restoreAllMocks();

    // A ticket has one label: one set before (a topic, or an automation rule's label) is kept alone.
    for (const label of ["billing", "web3"]) {
      vi.restoreAllMocks();
      const labelled = world({ labels: [label] }, { owner: ["sales", 1], topic: ["technical-support", 1] });
      await routeConversation(context(), 1, 5);
      expect(sent(labelled.requests, "POST", `${CW}/assignments`)).toHaveLength(1);
      expect(sent(labelled.requests, "POST", `${CW}/labels`)).toEqual([]);
    }
  });

  it("routes on a later customer message when the first one is unclear, and stops once routed", async () => {
    const store = new MapStore();
    const ticket: Ticket = { messages: [{ id: 1, content: "Hello", message_type: 0 }] };
    const jev: { owner: [string, number]; topic: [string, number] } = {
      owner: ["unclear", 1],
      topic: ["billing", 0.5],
    };
    const { requests } = world(ticket, jev);

    await routeConversation(context(store), 1, 5);
    ticket.messages = [...(ticket.messages ?? []), { id: 2, content: "My invoice is wrong", message_type: 0 }];
    jev.owner = ["cloud", 0.9];
    await routeConversation(context(store), 1, 5);
    ticket.messages = [...(ticket.messages ?? []), { id: 3, content: "Any news?", message_type: 0 }];
    await routeConversation(context(store), 1, 5);

    const asked = sent(requests, "POST", "api.typesafe.ai/v1/systemone").map((r) => JSON.parse(r.body).state.ticket);
    expect(asked).toEqual(["Hello", "Hello My invoice is wrong"]);
    expect(sent(requests, "POST", `${CW}/assignments`).map((r) => JSON.parse(r.body))).toEqual([{ assignee_id: 6 }]);
  });

  it("gives up after three customer messages without a clear owner", async () => {
    const store = new MapStore();
    const message = (id: number) => ({ id, content: `Message ${id}`, message_type: 0 });
    const ticket: Ticket = { messages: [message(1), message(2), message(3)] };
    const { requests } = world(ticket, { owner: ["cloud", 0.5], topic: ["billing", 0.5] });

    await routeConversation(context(store), 1, 5);
    ticket.messages = [...(ticket.messages ?? []), message(4)];
    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
  });

  it("with snoozeUnclear, snoozes a ticket it cannot assign until the customer's next message, not after the last try", async () => {
    const store = new MapStore();
    const message = (id: number) => ({ id, content: `Message ${id}`, message_type: 0 });
    const ticket: Ticket = { messages: [message(1)] };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0.5] });
    const snoozing = { ...ROUTING, snoozeUnclear: true };

    await routeConversation(context(store, snoozing), 1, 5);
    // The customer's next messages reopen the snoozed ticket (Chatwoot does).
    ticket.status = "open";
    ticket.messages = [message(1), message(2), message(3)];
    await routeConversation(context(store, snoozing), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(2);
    expect(sent(requests, "POST", `${CW}/toggle_status`).map((r) => JSON.parse(r.body))).toEqual([
      { status: "snoozed" },
    ]);
    await routeConversation(context(new MapStore()), 1, 5);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
  });

  it("with snoozeUnclear, leaves open a ticket it cannot assign whose customer asks for something", async () => {
    const ticket: Ticket = {};
    const snoozing = { ...ROUTING, snoozeUnclear: true };
    const store = new MapStore();
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0.5], request: ["request", 0.9] });

    await routeConversation(context(store, snoozing), 1, 5);

    const [ask] = sent(requests, "POST", "api.typesafe.ai/v1/systemone").map((r) => JSON.parse(r.body));
    expect(Object.keys(ask.questions.request.criteria)).toEqual(["request", "none"]);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("waiting");
  });

  it("does not snooze a ticket the customer wrote to while Jev was answering; that message's run asks again", async () => {
    const store = new MapStore();
    const message = (id: number) => ({ id, content: `Message ${id}`, message_type: 0 });
    const ticket: Ticket = { messages: [message(1)] };
    const snoozing = { ...ROUTING, snoozeUnclear: true };
    // The new message is followed by an agent's private note: it is still the customer's news.
    const note = { id: 3, content: "checking", message_type: 1, private: true };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0.5] }, 0, () => {
      if (ticket.messages?.length === 1) ticket.messages = [message(1), message(2), note];
    });

    await routeConversation(context(store, snoozing), 1, 5);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
    await routeConversation(context(store, snoozing), 1, 5);

    const asked = sent(requests, "POST", "api.typesafe.ai/v1/systemone").map((r) => JSON.parse(r.body).state.ticket);
    expect(asked).toEqual(["Message 1", "Message 1 Message 2"]);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
  });

  it("sees a customer message behind more than a page of notes: does not snooze, and asks Jev again with it", async () => {
    const store = new MapStore();
    const message = (id: number) => ({ id, content: `Message ${id}`, message_type: 0 });
    const ticket: Ticket = { messages: [message(1)] };
    const snoozing = { ...ROUTING, snoozeUnclear: true };
    const notes = Array.from({ length: 150 }, (_, i) => ({ id: i + 2, content: "note", message_type: 2 }));
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0.5] }, 0, () => {
      ticket.messages = [message(1), ...notes, message(200)];
    });

    await routeConversation(context(store, snoozing), 1, 5);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);

    // Its run gives Jev that message too.
    await routeConversation(context(store, snoozing), 1, 5);
    const asked = sent(requests, "POST", "api.typesafe.ai/v1/systemone").map((r) => JSON.parse(r.body).state.ticket);
    expect(asked).toEqual(["Message 1", "Message 1 Message 200"]);
  });

  it("does not snooze when it cannot read far enough to tell whether the customer wrote", async () => {
    const message = (id: number) => ({ id, content: `Message ${id}`, message_type: 0 });
    const ticket: Ticket = { messages: [message(1)] };
    const notes = Array.from({ length: 300 }, (_, i) => ({ id: i + 2, content: "note", message_type: 2 }));
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0.5] }, 0, () => {
      ticket.messages = [message(1), ...notes, message(400)];
    });

    await routeConversation(context(new MapStore(), { ...ROUTING, snoozeUnclear: true }), 1, 5);

    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
  });

  it("asks Jev again instead of applying a decision made before the customer's newest message", async () => {
    const store = new MapStore();
    const message = (id: number) => ({ id, content: `Message ${id}`, message_type: 0 });
    // The snooze reaches Chatwoot but its answer is lost: the decision stays unapplied.
    const ticket: Ticket = { messages: [message(1)], failSnooze: 1 };
    const snoozing = { ...ROUTING, snoozeUnclear: true };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0.5] });

    await expect(routeConversation(context(store, snoozing), 1, 5)).rejects.toThrow();
    ticket.messages = [message(1), message(2)];
    await routeConversation(context(store, snoozing), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(2);
  });

  it("sends the first customer messages, however long the conversation", async () => {
    const later = Array.from({ length: 30 }, (_, i) => ({ id: i + 2, content: "Any news?", message_type: 0 }));
    const { requests } = world(
      { messages: [{ id: 1, content: "My invoice is wrong", message_type: 0 }, ...later] },
      { owner: ["cloud", 1], topic: ["billing", 1] },
    );

    await routeConversation(context(), 1, 5);

    const [jev] = sent(requests, "POST", "api.typesafe.ai/v1/systemone");
    expect(JSON.parse(jev?.body ?? "{}").state.ticket).toBe("My invoice is wrong Any news? Any news?");
  });

  it("keeps an assignee or topic label someone set while Jev was answering, and routes no more", async () => {
    const store = new MapStore();
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] }, 0, () => {
      ticket.assignee = { id: 9, name: "Doyle" };
      ticket.labels = ["billing"];
    });

    await routeConversation(context(store), 1, 5);
    ticket.assignee = null;
    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    expect(sent(requests, "POST", `${CW}/labels`)).toEqual([]);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it("keeps the decision for a ticket closed while Jev was answering, and applies it once the ticket opens again", async () => {
    const store = new MapStore();
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] }, 0, () => {
      ticket.status = "resolved";
    });

    await routeConversation(context(store), 1, 5);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    ticket.status = "open";
    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/assignments`).map((r) => JSON.parse(r.body))).toEqual([{ assignee_id: 6 }]);
  });

  it("waits for a customer message before asking", async () => {
    const store = new MapStore();
    const { requests } = world({ messages: [] }, { owner: ["cloud", 1], topic: ["billing", 1] });

    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
    expect(store.values.size).toBe(0);
  });

  it("applies the recorded decision on a retry instead of asking Jev again", async () => {
    const store = new MapStore();
    const { requests } = world({}, { owner: ["sales", 0.95], topic: ["billing", 0.95] }, 1);

    await expect(routeConversation(context(store), 1, 5)).rejects.toThrow();
    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/assignments`).map((r) => JSON.parse(r.body))).toEqual([
      { assignee_id: 7 },
      { assignee_id: 7 },
    ]);
  });
});

describe("routeConversation with kinds", () => {
  const KINDS = {
    ...ROUTING,
    kinds: {
      "1": {
        "startup-program": { covers: "A Startup Program application.", cannedResponse: "startup-program" },
        security: { covers: "A security report.", cannedResponse: "security-report" },
        spam: { covers: "Spam.", status: "resolved" },
        "beg-bounty": { covers: "A templated security report.", cannedResponse: "security", status: "resolved" },
      },
    },
  };
  const replies = (requests: Recorded[]) =>
    sent(requests, "POST", `${CW}/messages`).map((request) => JSON.parse(request.body));

  it("replies once to a ticket of a kind Jev is sure of, after assigning it, and not when unsure", async () => {
    const store = new MapStore();
    const ticket: Ticket = {};
    const { requests } = world(ticket, {
      owner: ["cloud", 1],
      topic: ["billing", 1],
      kind: ["startup-program", 0.9],
    });

    await routeConversation(context(store, KINDS), 1, 5);
    expect(replies(requests)).toEqual([{ content: "Thanks for applying!", message_type: "outgoing", private: false }]);
    // The customer message it answers calls no triage bot; a later one does.
    expect(handledAutomatically(store, 1, 5, 1)).toBe(true);
    expect(handledAutomatically(store, 1, 5, 3)).toBe(false);
    // The topic and the kind are labels of their own families.
    expect(sent(requests, "POST", `${CW}/labels`).map((r) => JSON.parse(r.body))).toEqual([
      { labels: ["billing", "startup-program"] },
    ]);
    await routeConversation(context(store, KINDS), 1, 5);
    expect(replies(requests)).toHaveLength(1);

    const unsure = world({}, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 0.5] });
    await routeConversation(context(new MapStore(), KINDS), 1, 5);
    expect(replies(unsure.requests)).toEqual([]);
  });

  it("sends no reply while the kind's canned response does not exist", async () => {
    const store = new MapStore();
    const { requests } = world({}, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["security", 1] });

    await routeConversation(context(store, KINDS), 1, 5);

    expect(replies(requests)).toEqual([]);
    expect(handledAutomatically(store, 1, 5, 1)).toBe(false);
    expect(sent(requests, "POST", `${CW}/labels`).map((r) => JSON.parse(r.body))).toEqual([
      { labels: ["billing", "security"] },
    ]);
  });

  it("adds the topic to a ticket whose only labels are kinds", async () => {
    const { requests } = world({ labels: ["spam"] }, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["none", 1] });

    await routeConversation(context(new MapStore(), KINDS), 1, 5);

    expect(sent(requests, "POST", `${CW}/labels`).map((r) => JSON.parse(r.body))).toEqual([
      { labels: ["spam", "billing"] },
    ]);
  });

  it("never sends a reply twice, even when sending it failed", async () => {
    const store = new MapStore();
    const ticket: Ticket = { failReply: 1 };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });

    await expect(routeConversation(context(store, KINDS), 1, 5)).rejects.toThrow();
    await routeConversation(context(store, KINDS), 1, 5);

    expect(replies(requests)).toHaveLength(1);
    // Not sent: the triage bot still answers the customer.
    expect(handledAutomatically(store, 1, 5, 1)).toBe(false);
  });

  it("replies as the account's agent bot, under its name, also before the ticket has an owner", async () => {
    const { requests } = world({}, { owner: ["unclear", 1], topic: ["billing", 1], kind: ["startup-program", 1] });

    await routeConversation(context(new MapStore(), KINDS), 1, 5);

    const [reply] = sent(requests, "POST", `${CW}/messages`);
    expect(reply?.headers.get("api_access_token")).toBe("bot-token");
    // A bot's reply assigns nobody.
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
  });

  it("resolves a spam ticket instead of routing it, without blocking its contact", async () => {
    const store = new MapStore();
    const { requests } = world({}, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["spam", 0.95] });

    await routeConversation(context(store, KINDS), 1, 5);

    expect(sent(requests, "POST", `${CW}/toggle_status`).map((r) => JSON.parse(r.body))).toEqual([
      { status: "resolved" },
    ]);
    expect(sent(requests, "PUT", "chatwoot.example.com/api/v1/accounts/1/contacts/88")).toEqual([]);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    // Its kind is a label; it gets no topic.
    expect(sent(requests, "POST", `${CW}/labels`).map((r) => JSON.parse(r.body))).toEqual([{ labels: ["spam"] }]);
    expect(replies(requests)).toEqual([]);
    // The customer message it handled calls no triage bot.
    expect(handledAutomatically(store, 1, 5, 1)).toBe(true);
  });

  it("replies to a ticket of a kind that sets it aside, then sets it aside, once", async () => {
    const store = new MapStore();
    const ticket: Ticket = { loseStatusAnswer: 1 };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 0.95] });

    await expect(routeConversation(context(store, KINDS), 1, 5)).rejects.toThrow();
    await routeConversation(context(store, KINDS), 1, 5);

    expect(replies(requests)).toEqual([
      { content: "Please report it to security@example.com.", message_type: "outgoing", private: false },
    ]);
    // Replied before it is resolved.
    const at = (method: string, path: string) =>
      requests.findIndex((r) => r.method === method && r.url.pathname === `/api/v1/accounts/1/conversations/5/${path}`);
    expect(at("POST", "messages")).toBeGreaterThan(-1);
    expect(at("POST", "messages")).toBeLessThan(at("POST", "toggle_status"));
    expect(ticket.status).toBe("resolved");
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    expect(handledAutomatically(store, 1, 5, 1)).toBe(true);
  });

  it("completes a set-aside whose status Chatwoot made but whose answer was lost, without setting it again", async () => {
    const store = new MapStore();
    const ticket: Ticket = { loseStatusAnswer: 1 };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["spam", 0.95] });

    await expect(routeConversation(context(store, KINDS), 1, 5)).rejects.toThrow();
    await routeConversation(context(store, KINDS), 1, 5);

    expect(ticket.status).toBe("resolved");
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("done");
  });

  it("does not set aside a ticket someone took while Jev was answering", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["spam", 0.95] }, 0, () => {
      ticket.assignee = { id: 9, name: "Doyle" };
    });

    await routeConversation(context(new MapStore(), KINDS), 1, 5);

    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
  });
});

describe("actsAutomatically", () => {
  it("is true for an account whose kinds set tickets aside or reply with its agent bot", () => {
    const settings = (kinds: object, bots: object) =>
      testSettings(
        { routing: { ...ROUTING, kinds: { "1": kinds } } },
        { TYPESAFE_API_KEY: "ts-key", CHATWOOT_BOT_TOKENS: JSON.stringify(bots) },
      );
    expect(actsAutomatically(settings({ spam: { covers: "Spam.", status: "resolved" } }, {}), 1)).toBe(true);
    expect(actsAutomatically(settings({ security: { covers: "S.", cannedResponse: "s" } }, { "1": "bot" }), 1)).toBe(
      true,
    );
    expect(actsAutomatically(settings({ other: { covers: "Other." } }, {}), 1)).toBe(false);
    expect(actsAutomatically(settings({ spam: { covers: "Spam.", status: "resolved" } }, {}), 2)).toBe(false);
  });
});

describe("sanitize", () => {
  it("removes identifiers", () => {
    const text =
      "Hi, I'm Alice Chen (alice.chen@example.com, +1 415-555-0199). See https://cloud.example.com/x; " +
      "wallet 0x52908400098527886E0F7030069857D2E4169EE7 and 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY, " +
      "key Zq9x_abcdefghijklmnopqrstuvwxyz0123456789ABCD, ip 10.1.2.3, ping @alicec. Thanks, Alice";
    expect(sanitize(text, ["Alice Chen", "alice.chen@example.com"])).toBe(
      "Hi, I'm [REDACTED] ([REDACTED], [REDACTED]). See [REDACTED] wallet [REDACTED] and [REDACTED], " +
        "key [REDACTED], ip [REDACTED], ping [REDACTED] Thanks, [REDACTED]",
    );
  });

  it("removes IP addresses, but not times, MAC addresses, versions, or paths", () => {
    const text =
      "from 2001:db8::1, 2001:db8:1234::192.0.2.1, ::ffff:198.51.100.7, and fe80::1%eth0 at 10:30:00 " +
      "(MAC aa:bb:cc:dd:ee:ff, v1.2.3.4, build 1.2.3.4.5, std::vec). My IP is 10.1.2.3.";
    expect(sanitize(text, [])).toBe(
      "from [REDACTED], [REDACTED], [REDACTED], and [REDACTED] at 10:30:00 " +
        "(MAC aa:bb:cc:dd:ee:ff, v1.2.3.4, build 1.2.3.4.5, std::vec). My IP is [REDACTED].",
    );
  });
});
