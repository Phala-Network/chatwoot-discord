import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { needsCompletionRepair, writeCompletion } from "../src/completion.ts";
import { ROUTE_BUDGET } from "../src/router.ts";
import { type RoutingStore, routeConversation, sanitize } from "../src/routing.ts";
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
  name?: string;
  blocked?: boolean;
  assignee?: { id: number; name: string } | null;
  status?: string;
  labels?: string[];
  attributes?: Record<string, unknown>;
  failAttributes?: number;
  failLabels?: number;
  failCompletionRead?: number;
  loseAssignAnswer?: number;
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
  let replied = false;
  ticket.messages ??= [
    { id: 1, content: "My CVM will not start, says Jane Doe (jane@example.com)", message_type: 0 },
    { id: 2, content: "Looking into it", message_type: 1 },
  ];
  const conversation = () => ({
    id: 5,
    status: ticket.status ?? "open",
    inbox_id: 2,
    custom_attributes: ticket.attributes ?? {},
    labels: ticket.labels ?? [],
    meta: {
      sender: { id: 88, name: ticket.name ?? "Jane Doe", email: "jane@example.com", blocked: ticket.blocked ?? false },
      assignee: ticket.assignee ?? null,
    },
    last_non_activity_message: (ticket.messages ?? []).filter((m) => m.message_type <= 1).at(-1) ?? null,
  });
  const mock = mockFetch(
    on("GET", CW, () => {
      if (replied && (ticket.failCompletionRead ?? 0) > 0) {
        ticket.failCompletionRead = (ticket.failCompletionRead ?? 0) - 1;
        return json({}, { status: 503 });
      }
      return json(conversation());
    }),
    on("GET", `${CW}/messages`, (request) => {
      const all = (ticket.messages ?? []).filter(
        (message) =>
          !request.url.searchParams.has("filter_internal_messages") || (!message.private && message.message_type !== 2),
      );
      // Chatwoot's MessageFinder: the latest 20 without `after`, else up to 100 after that id.
      const after = request.url.searchParams.get("after");
      const payload = after === null ? all.slice(-20) : all.filter((m) => m.id > Number(after)).slice(0, 100);
      return json({ payload });
    }),
    on("POST", `${CW}/assignments`, (request) => {
      if (failures > 0) {
        failures -= 1;
        return json({ error: "unavailable" }, { status: 503 });
      }
      ticket.assignee = { id: JSON.parse(request.body).assignee_id, name: "Routed agent" };
      if ((ticket.loseAssignAnswer ?? 0) > 0) {
        ticket.loseAssignAnswer = (ticket.loseAssignAnswer ?? 0) - 1;
        return json({}, { status: 503 });
      }
      return json({});
    }),
    on("POST", `${CW}/labels`, (request) => {
      if ((ticket.failLabels ?? 0) > 0) {
        ticket.failLabels = (ticket.failLabels ?? 0) - 1;
        return json({}, { status: 503 });
      }
      ticket.labels = JSON.parse(request.body).labels;
      return json({});
    }),
    on("POST", `${CW}/custom_attributes`, (request) => {
      if ((ticket.failAttributes ?? 0) > 0) {
        ticket.failAttributes = (ticket.failAttributes ?? 0) - 1;
        return json({}, { status: 503 });
      }
      const body = JSON.parse(request.body);
      expect(body.merge).toBe(true);
      ticket.attributes = { ...ticket.attributes, ...body.custom_attributes };
      return json({});
    }),
    on("GET", "chatwoot.example.com/api/v1/accounts/1/canned_responses", () =>
      json([
        { id: 1, short_code: "startup", content: "Hello" },
        { id: 2, short_code: "startup-program", content: "Thanks for applying!" },
        { id: 3, short_code: "security", content: "Please report it to security@example.com." },
      ]),
    ),
    on("POST", `${CW}/messages`, (request) => {
      if ((ticket.failReply ?? 0) > 0) {
        ticket.failReply = (ticket.failReply ?? 0) - 1;
        return json({ error: "unavailable" }, { status: 503 });
      }
      const body = JSON.parse(request.body);
      ticket.messages?.push({
        id: (ticket.messages.at(-1)?.id ?? 0) + 1,
        content: body.content,
        message_type: 1,
        private: body.private,
      });
      replied = true;
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
const attributes = (requests: Recorded[]) =>
  JSON.parse(sent(requests, "POST", `${CW}/custom_attributes`).at(-1)?.body ?? "{}").custom_attributes ?? {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("routeConversation", () => {
  it("filters internal messages for routing without filtering the relay's reads", async () => {
    const ticket: Ticket = {
      messages: [
        { id: 1, content: "Hello", message_type: 0 },
        ...Array.from({ length: 400 }, (_, index) => ({
          id: index + 2,
          content: "Internal",
          message_type: index % 2 ? 2 : 1,
          private: index % 2 === 0,
        })),
      ],
    };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0] });
    const ctx = context(new MapStore(), { ...ROUTING, snoozeUnclear: true });
    await routeConversation(ctx, 1, 5);
    expect(ticket.status).toBe("snoozed");
    expect(
      sent(requests, "GET", `${CW}/messages`).every(
        (request) => request.url.searchParams.get("filter_internal_messages") === "true",
      ),
    ).toBe(true);
    const unfiltered = await ctx.chatwoot.listMessages(1, 5);
    expect(unfiltered.some((message) => message.private)).toBe(true);
    expect(unfiltered.some((message) => message.message_type === 2)).toBe(true);
    expect(requests.at(-1)?.url.searchParams.has("filter_internal_messages")).toBe(false);
  });

  it("does not classify an identifier containing the contact's name", async () => {
    const ticket: Ticket = {
      name: "Example Customer",
      messages: [{ id: 1, content: "example@example.com", message_type: 0 }],
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    const store = new MapStore();
    await routeConversation(context(store), 1, 5);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
    expect(ticket.attributes).toEqual({ routing_seen: 1 });
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("waiting");
  });

  it.each([false, true])(
    "resumes after its own snooze, a webhook, and a customer reopening: lost response=%s",
    async (lost) => {
      const ticket: Ticket = {
        messages: [{ id: 1, content: "Hello", message_type: 0 }],
        loseStatusAnswer: lost ? 1 : 0,
      };
      const jev: { owner: [string, number]; topic: [string, number] } = {
        owner: ["unclear", 1],
        topic: ["billing", 0],
      };
      const { requests } = world(ticket, jev);
      const store = new MapStore();
      const ctx = context(store, { ...ROUTING, snoozeUnclear: true });
      if (lost) await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
      else await routeConversation(ctx, 1, 5);
      const recorded = store.get("route:1:5");
      expect(JSON.parse(recorded ?? "{}").state).toBe(lost ? "pending" : "waiting");
      expect(ticket.status).toBe("snoozed");
      await routeConversation(ctx, 1, 5);
      expect(store.get("route:1:5")).toBe(recorded);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
      ticket.status = "open";
      ticket.messages?.push({ id: 2, content: "Where is my invoice?", message_type: 0 });
      jev.owner = ["cloud", 1];
      await routeConversation(ctx, 1, 5);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(2);
      expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
      expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
      expect(ticket.attributes).toEqual({ routing_seen: 2 });
      expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("done");
    },
  );
  it("retains the text window after attachment-only messages while waiting for an owner", async () => {
    const ticket: Ticket = { messages: [1, 2, 3].map((id) => ({ id, content: "", message_type: 0 })) };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0] });
    const store = new MapStore();
    const ctx = context(store);
    await routeConversation(ctx, 1, 5);
    ticket.messages?.push({ id: 4, content: "Invoice missing", message_type: 0 });
    await routeConversation(ctx, 1, 5);
    ticket.messages?.push({ id: 5, content: "Payment failed", message_type: 0 });
    await routeConversation(ctx, 1, 5);
    expect(JSON.parse(store.get("route:1:5") ?? "{}").messages).toBe(2);
    expect(
      sent(requests, "POST", "api.typesafe.ai/v1/systemone").map((request) => JSON.parse(request.body).state.ticket),
    ).toEqual(["Invoice missing", "Invoice missing Payment failed"]);
    expect(ticket.attributes).toEqual({ routing_seen: 5 });
  });
  it.each([false, true])("acknowledges a blocked contact without routing: blocked during Jev=%s", async (during) => {
    const ticket: Ticket = { blocked: !during };
    const { requests } = world(
      ticket,
      { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 1] },
      0,
      () => {
        ticket.blocked = true;
      },
    );
    const ctx = context(new MapStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    await routeConversation(ctx, 1, 5);
    expect(ticket.attributes).toEqual({ routing_seen: 1 });
    expect(
      requests
        .filter((request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com")
        .map((request) => request.url.pathname),
    ).toEqual(["/api/v1/accounts/1/conversations/5/custom_attributes"]);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(during ? 1 : 0);
  });

  it.each(["", "jane@example.com", "Jane Doe"])(
    "waits for text instead of classifying empty or redacted messages: %j",
    async (content) => {
      const ticket: Ticket = { messages: [1, 2, 3].map((id) => ({ id, content, message_type: 0 })) };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 1] });
      const store = new MapStore();
      const ctx = context(store, { ...KINDS, snoozeUnclear: true });
      await routeConversation(ctx, 1, 5);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
      expect(ticket.attributes).toEqual({ routing_seen: 3 });
      expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("waiting");
      expect(ticket.status).toBeUndefined();
      ticket.messages?.push({ id: 4, content: "Where is my invoice?", message_type: 0 });
      await routeConversation(ctx, 1, 5);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
      expect(ticket.attributes?.routing_seen).toBe(4);
    },
  );
  it.each([false, true])("fits the worst-case route at its request boundary: sufficient=%s", async (sufficient) => {
    const store = new MapStore();
    store.set(
      "route:1:5",
      JSON.stringify({
        owner: null,
        ownerConfidence: 0,
        topic: null,
        topicConfidence: 0,
        messages: 0,
        lastMessageId: 0,
        state: "pending",
      }),
    );
    const ticket: Ticket = {
      messages: Array.from({ length: 403 }, (_, index) => ({
        id: index + 1,
        message_type: index === 200 || index === 201 ? 0 : 1,
        content: index === 200 || index === 201 ? "Hello." : "Agent reply.",
      })),
    };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(store, { ...KINDS, snoozeUnclear: true });
    const budget = new Budget(ROUTE_BUDGET - (sufficient ? 0 : 1));
    const run = routeConversation(
      {
        ...ctx,
        fetch: budget.fetch,
        chatwoot: chatwootClient(ctx.settings.config.chatwoot.baseUrl, "agent-token", budget.fetch),
      },
      1,
      5,
    );
    if (sufficient) {
      await run;
      expect(ticket.attributes).toEqual({ routing_seen: 202, routing_handled: 202, routing_kind: "startup-program" });
      expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("waiting");
    } else {
      await expect(run).rejects.toBeInstanceOf(BudgetExhaustedError);
      expect(ticket.attributes).toBeUndefined();
      expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("waiting");
    }
    expect(ticket.status).toBe("snoozed");
    expect(budget.remaining).toBe(0);
    expect(requests).toHaveLength(budget.limit);
  });

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

  it("leaves a pending decision unchanged while assigned and applies it after unassignment", async () => {
    const store = new MapStore();
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] }, 0, () => {
      ticket.assignee = { id: 9, name: "Doyle" };
      ticket.labels = ["billing"];
    });

    await routeConversation(context(store), 1, 5);
    const recorded = store.get("route:1:5");
    expect(JSON.parse(recorded ?? "{}").state).toBe("pending");
    await routeConversation(context(store), 1, 5);
    expect(store.get("route:1:5")).toBe(recorded);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    ticket.assignee = null;
    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/labels`)).toEqual([]);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it("preserves a decision closed by a person during Jev and applies it when reopened", async () => {
    const store = new MapStore();
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] }, 0, () => {
      ticket.status = "resolved";
    });

    await routeConversation(context(store), 1, 5);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("pending");
    ticket.status = "open";
    await routeConversation(context(store), 1, 5);

    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("done");
    expect(ticket.attributes).toEqual({ routing_seen: 1 });
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

describe("routeConversation with kinds", () => {
  it.each(["latest", "watermark"])(
    "resumes a waiting decision from %s evidence beyond public replies",
    async (evidence) => {
      const ticket: Ticket = { messages: [{ id: 1, content: "A startup application", message_type: 0 }] };
      const answer: { owner: [string, number]; topic: [string, number]; kind: [string, number] } = {
        owner: ["unclear", 1],
        topic: ["billing", 1],
        kind: ["startup-program", 1],
      };
      const { requests } = world(ticket, answer);
      const ctx = context(new MapStore(), KINDS);
      await routeConversation(ctx, 1, 5);
      ticket.messages?.push(
        ...Array.from({ length: 400 }, (_, index) => ({ id: index + 3, content: "Agent reply", message_type: 1 })),
        { id: 403, content: "A different billing request", message_type: 0 },
        ...(evidence === "watermark"
          ? Array.from({ length: 30 }, (_, index) => ({ id: index + 404, content: "Agent reply", message_type: 1 }))
          : []),
      );
      answer.owner = ["cloud", 1];
      answer.kind = ["none", 1];
      await routeConversation(ctx, 1, 5, evidence === "watermark" ? 403 : 0);
      const asked = sent(requests, "POST", "api.typesafe.ai/v1/systemone");
      expect(asked).toHaveLength(2);
      expect(JSON.parse(asked.at(-1)?.body ?? "{}").state.ticket).toContain("A different billing request");
      expect(replies(requests)).toHaveLength(1);
      expect(ticket.assignee?.id).toBe(6);
      expect(ticket.attributes).toEqual({ routing_seen: 403, routing_handled: 1, routing_kind: "startup-program" });
    },
  );

  it.each([
    { evidence: "latest", internal: true },
    { evidence: "watermark", internal: true },
    { evidence: "latest", internal: false },
    { evidence: "watermark", internal: false },
  ])("redecides from $evidence evidence beyond 400 messages: internal=$internal", async ({ evidence, internal }) => {
    const ticket: Ticket = { messages: [{ id: 1, content: "A startup application", message_type: 0 }], failLabels: 1 };
    const answer: { owner: [string, number]; topic: [string, number]; kind: [string, number] } = {
      owner: ["unclear", 1],
      topic: ["billing", 1],
      kind: ["startup-program", 1],
    };
    const { requests } = world(ticket, answer);
    const ctx = context(new MapStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
    ticket.messages?.push(
      ...Array.from({ length: 400 }, (_, index) => ({
        id: index + 2,
        content: "Activity or agent reply",
        message_type: internal ? 2 : 1,
      })),
      { id: 402, content: "A different billing request", message_type: 0 },
      ...(evidence === "watermark"
        ? Array.from({ length: 30 }, (_, index) => ({ id: index + 403, content: "Agent reply", message_type: 1 }))
        : []),
    );
    answer.owner = ["cloud", 1];
    answer.kind = ["none", 1];
    await routeConversation(ctx, 1, 5, evidence === "watermark" ? 402 : 0);
    const asked = sent(requests, "POST", "api.typesafe.ai/v1/systemone");
    expect(asked).toHaveLength(2);
    expect(JSON.parse(asked.at(-1)?.body ?? "{}").state.ticket).toContain("A different billing request");
    expect(replies(requests)).toEqual([]);
    expect(ticket.assignee?.id).toBe(6);
    expect(ticket.attributes).toEqual({ routing_seen: 402 });
  });

  it.each(["labels", "assignment response"])("finishes its own assignment after losing %s", async (failure) => {
    const ticket: Ticket = {
      failLabels: failure === "labels" ? 1 : 0,
      loseAssignAnswer: failure === "assignment response" ? 1 : 0,
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const store = new MapStore();
    const ctx = context(store, KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
    expect(ticket.assignee?.id).toBe(6);
    expect(replies(requests)).toEqual([]);
    await routeConversation(ctx, 1, 5);
    expect(ticket.labels).toEqual(["billing", "startup-program"]);
    expect(replies(requests)).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(ticket.attributes).toEqual({ routing_seen: 1, routing_handled: 1, routing_kind: "startup-program" });
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("done");
  });

  it("leaves a different assignee alone after its own assignment succeeds", async () => {
    const ticket: Ticket = { failLabels: 1 };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const store = new MapStore();
    const ctx = context(store, KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
    ticket.assignee = { id: 9, name: "Doyle" };
    const recorded = store.get("route:1:5");
    await routeConversation(ctx, 1, 5);
    expect(ticket.labels).toBeUndefined();
    expect(replies(requests)).toEqual([]);
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
    expect(store.get("route:1:5")).toBe(recorded);
    expect(ticket.attributes).toEqual({ routing_seen: 1 });
  });

  it.each(["retry", "repair"])(
    "records completion before a failing completion GET and recovers by %s",
    async (recovery) => {
      const ticket: Ticket = { failCompletionRead: 1 };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
      const store = new MapStore();
      const ctx = context(store, KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
      expect(ticket.assignee?.id).toBe(6);
      expect(ticket.labels).toEqual(["billing", "startup-program"]);
      expect(replies(requests)).toHaveLength(1);
      expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("done");
      expect(needsCompletionRepair(ctx, 1, { id: 5, custom_attributes: {} })).toBe(true);
      if (recovery === "retry") await routeConversation(ctx, 1, 5);
      else await writeCompletion(ctx, 1, 5);
      expect(ticket.attributes).toEqual({ routing_seen: 1, routing_handled: 1, routing_kind: "startup-program" });
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
      expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
      expect(sent(requests, "POST", `${CW}/labels`)).toHaveLength(1);
      expect(replies(requests)).toHaveLength(1);
    },
  );

  it.each(["resolved", "snoozed", "pending"])(
    "acknowledges already-%s tickets without recording a decision",
    async (status) => {
      const ticket: Ticket = { status };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 1] });
      const store = new MapStore();
      await routeConversation(context(store, KINDS), 1, 5);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
      expect(store.get("route:1:5")).toBeUndefined();
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
      expect(replies(requests)).toEqual([]);
    },
  );
  it.each([
    { kind: "beg-bounty", count: 1 },
    { kind: "startup-program", count: 1 },
  ])("redecides a stale $kind kind after $count messages before any action", async ({ kind, count }) => {
    const ticket: Ticket = {
      messages: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        content: "First request",
        message_type: 0,
      })),
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: [kind, 1] }, 0, () => {
      if (ticket.messages?.length === count)
        ticket.messages.push({ id: count + 1, content: "A different request", message_type: 0 });
    });
    const store = new MapStore();
    const ctx = context(store, KINDS);
    expect(await routeConversation(ctx, 1, 5)).toBe("defer");
    expect(
      requests.filter((request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com"),
    ).toEqual([]);
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("pending");
    await routeConversation(ctx, 1, 5);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(2);
    expect(
      JSON.parse(sent(requests, "POST", "api.typesafe.ai/v1/systemone").at(-1)?.body ?? "{}").state.ticket,
    ).toContain("A different request");
    expect(ticket.attributes).toEqual({ routing_seen: count + 1, routing_handled: count + 1, routing_kind: kind });
    expect(replies(requests)).toHaveLength(1);
  });

  it.each(["spam", "beg-bounty", "startup-program"])(
    "retries a full %s window without redeciding on later messages",
    async (kind) => {
      const ticket: Ticket = {
        messages: [1, 2, 3].map((id) => ({ id, message_type: 0, content: `Request ${id}` })),
        failLabels: 1,
      };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: [kind, 1] });
      const store = new MapStore();
      const ctx = context(store, KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
      ticket.messages?.push(
        ...Array.from({ length: 400 }, (_, index) => ({ id: index + 4, message_type: 1, content: "Agent reply" })),
        { id: 404, message_type: 0, content: "Later request" },
      );
      await routeConversation(ctx, 1, 5);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
      expect(JSON.parse(store.get("route:1:5") ?? "{}")).toMatchObject({
        state: "done",
        messages: 3,
        lastMessageId: 3,
      });
      expect(ticket.attributes).toEqual({ routing_seen: 404, routing_handled: 3, routing_kind: kind });
      expect(replies(requests)).toHaveLength(kind === "spam" ? 0 : 1);
      expect(ticket.status ?? "open").toBe(kind === "startup-program" ? "open" : "resolved");
    },
  );

  it.each(["resolved", "snoozed", "pending"])(
    "does not reply or change a ticket a person made %s during Jev",
    async (status) => {
      const ticket: Ticket = {};
      const { requests } = world(
        ticket,
        { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 1] },
        0,
        () => {
          ticket.status = status;
        },
      );
      const store = new MapStore();
      await routeConversation(context(store, KINDS), 1, 5);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
      expect(
        requests
          .filter((request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com")
          .map((request) => request.url.pathname),
      ).toEqual(["/api/v1/accounts/1/conversations/5/custom_attributes"]);
      expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("pending");
    },
  );

  it.each(["resolved", "snoozed", "pending", "assigned"])(
    "does not reply after label 503 then a person makes the ticket %s",
    async (status) => {
      const ticket: Ticket = { failLabels: 1 };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 1] });
      const store = new MapStore();
      const ctx = context(store, KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
      const recorded = store.get("route:1:5");
      if (status === "assigned") ticket.assignee = { id: 9, name: "Doyle" };
      else ticket.status = status;
      const before = requests.length;
      await routeConversation(ctx, 1, 5);
      expect(store.get("route:1:5")).toBe(recorded);
      expect(JSON.parse(recorded ?? "{}").state).toBe("pending");
      expect(replies(requests)).toEqual([]);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
      expect(
        requests
          .slice(before)
          .filter((request) => request.method === "POST")
          .map((request) => request.url.pathname),
      ).toEqual(["/api/v1/accounts/1/conversations/5/custom_attributes"]);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    },
  );

  it.each([
    { kind: "none", retry: false },
    { kind: "spam", retry: false },
    { kind: "beg-bounty", retry: false },
    { kind: "startup-program", retry: false },
    { kind: "none", retry: true },
    { kind: "spam", retry: true },
    { kind: "beg-bounty", retry: true },
    { kind: "startup-program", retry: true },
  ])("finalizes $kind without a status action beyond 400 public replies: retry=$retry", async ({ kind, retry }) => {
    const ticket: Ticket = {
      messages: [{ id: 1, content: "Hello", message_type: 0 }],
      failLabels: retry ? 1 : 0,
    };
    const activity = Array.from({ length: 400 }, (_, index) => ({
      id: index + 2,
      content: "Agent reply",
      message_type: 1,
    }));
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 1], kind: [kind, 1] }, 0, () => {
      if (!retry) ticket.messages?.push(...activity);
    });
    const store = new MapStore();
    const ctx = context(store, { ...KINDS, snoozeUnclear: true });
    if (retry) {
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
      ticket.messages?.push(...activity);
    }
    await routeConversation(ctx, 1, 5);
    expect(JSON.parse(store.get("route:1:5") ?? "{}").state).toBe("done");
    expect(ticket.attributes?.routing_seen).toBe(1);
    expect(ticket.attributes?.routing_kind).toBe(kind === "none" ? undefined : kind);
    expect(ticket.attributes?.routing_handled).toBe(
      kind === "beg-bounty" || kind === "startup-program" ? 1 : undefined,
    );
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
    expect(sent(requests, "POST", `${CW}/labels`).length).toBeGreaterThan(0);
    await routeConversation(ctx, 1, 5);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(replies(requests)).toHaveLength(kind === "beg-bounty" || kind === "startup-program" ? 1 : 0);
  });
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
    expect(attributes(requests).routing_handled).toBe(1);
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
    expect(attributes(requests).routing_handled).toBeUndefined();
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
    expect(attributes(requests).routing_handled).toBeUndefined();
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
    expect(attributes(requests).routing_handled).toBe(1);
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
    expect(attributes(requests).routing_handled).toBe(1);
  });

  it.each(["spam", "beg-bounty"])(
    "acknowledges a lost %s status response without changing the pending decision",
    async (kind) => {
      const store = new MapStore();
      const ticket: Ticket = { loseStatusAnswer: 1 };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: [kind, 0.95] });

      await expect(routeConversation(context(store, KINDS), 1, 5)).rejects.toThrow();
      const recorded = store.get("route:1:5");
      await routeConversation(context(store, KINDS), 1, 5);

      expect(ticket.status).toBe("resolved");
      expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
      expect(store.get("route:1:5")).toBe(recorded);
      expect(JSON.parse(recorded ?? "{}").state).toBe("pending");
      expect(replies(requests)).toHaveLength(kind === "spam" ? 0 : 1);
      expect(ticket.attributes).toEqual({ routing_seen: 1, ...(kind === "spam" ? {} : { routing_handled: 1 }) });
    },
  );

  it("does not set aside a ticket someone took while Jev was answering", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["spam", 0.95] }, 0, () => {
      ticket.assignee = { id: 9, name: "Doyle" };
    });

    await routeConversation(context(new MapStore(), KINDS), 1, 5);

    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
  });
});

describe("coordination attributes", () => {
  it("applies the first three inputs and acknowledges later messages without marking them handled", async () => {
    const ticket: Ticket = {
      messages: [1, 2, 3, 4, 5].map((id) => ({ id, message_type: 0, content: "Customer question." })),
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    expect(ticket.attributes).toEqual({ routing_seen: 5, routing_handled: 3, routing_kind: "startup-program" });
    await routeConversation(ctx, 1, 5);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(replies(requests)).toHaveLength(1);
    expect(ticket.attributes).toEqual({ routing_seen: 5, routing_handled: 3, routing_kind: "startup-program" });
  });

  it.each(["assigned", "resolved", "snoozed", "cutover"])(
    "acknowledges customer messages skipped because of %s without calling Jev",
    async (reason) => {
      const ticket: Ticket = {
        ...(reason === "assigned" ? { assignee: { id: 9, name: "Doyle" } } : {}),
        ...(reason === "resolved" || reason === "snoozed" ? { status: reason } : {}),
      };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
      const ctx = context();
      if (reason === "cutover") ctx.settings.config.startAfterConversationId = { "1": 5 };
      await routeConversation(ctx, 1, 5, 101);
      expect(ticket.attributes).toMatchObject({ routing_seen: 101 });
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
      expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    },
  );

  it("acknowledges later messages after a final decision without handling or classifying them again", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    await routeConversation(ctx, 1, 5, 200);
    expect(ticket.attributes).toMatchObject({ routing_seen: 200, routing_handled: 1, routing_kind: "startup-program" });
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(replies(requests)).toHaveLength(1);
  });

  it("does not publish seen before a failed canned reply settles", async () => {
    const ticket: Ticket = { failReply: 1 };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
    expect(ticket.attributes).toBeUndefined();
    await routeConversation(ctx, 1, 5);
    expect(ticket.attributes).toMatchObject({ routing_seen: 1, routing_kind: "startup-program" });
    expect(ticket.attributes).not.toHaveProperty("routing_handled");
  });

  it("writes seen, handled, and kind together after all routing actions", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    await routeConversation(context(new MapStore(), KINDS), 1, 5);
    const writes = requests.filter((request) => request.method === "POST");
    expect(JSON.parse(writes.at(-1)?.body ?? "{}")).toEqual({
      merge: true,
      custom_attributes: { routing_seen: 1, routing_handled: 1, routing_kind: "startup-program" },
    });
    expect(writes.at(-2)?.url.pathname).toBe("/api/v1/accounts/1/conversations/5/messages");
  });

  it.each(["done", "waiting", "skipped"])(
    "repairs lost %s watermarks after a relay read-merge-save without replaying actions",
    async (state) => {
      const ticket: Ticket = {
        ...(state === "skipped" ? { assignee: { id: 9, name: "Doyle" } } : {}),
        messages: [{ id: 101, content: "Billing question", message_type: 0 }],
      };
      const { requests } = world(ticket, {
        owner: [state === "waiting" ? "unclear" : "cloud", 1],
        topic: ["billing", 1],
        kind: ["startup-program", 1],
      });
      const ctx = context(new MapStore(), KINDS);
      await routeConversation(ctx, 1, 5, 101);
      const expected = { ...ticket.attributes };
      expect(expected.routing_seen).toBe(101);
      const decisions = sent(requests, "POST", "api.typesafe.ai/v1/systemone").length;
      const repliesBefore = replies(requests).length;
      ticket.attributes = { discord_thread: "https://discord.com/channels/100000000000000001/100000000000000002" };
      await routeConversation(ctx, 1, 5);
      expect(ticket.attributes).toEqual({
        discord_thread: "https://discord.com/channels/100000000000000001/100000000000000002",
        ...expected,
      });
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(decisions);
      expect(replies(requests)).toHaveLength(repliesBefore);
      const writes = sent(requests, "POST", `${CW}/custom_attributes`).length;
      await routeConversation(ctx, 1, 5);
      expect(sent(requests, "POST", `${CW}/custom_attributes`)).toHaveLength(writes);
    },
  );

  it("preserves newer observed watermarks through a subsequent lost update", async () => {
    const ticket: Ticket = { attributes: { routing_seen: 300, routing_handled: 250 } };
    world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    const ctx = context();
    await routeConversation(ctx, 1, 5);
    ticket.attributes = { routing_seen: 1, routing_handled: 1 };
    await routeConversation(ctx, 1, 5, 200);
    expect(ticket.attributes).toMatchObject({ routing_seen: 300, routing_handled: 250 });
  });

  it("preserves numeric-string completion watermarks through a lost update", async () => {
    const ticket: Ticket = { attributes: { routing_seen: "300", routing_handled: "250" } };
    world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    const ctx = context();
    await routeConversation(ctx, 1, 5);
    ticket.attributes = {};
    await routeConversation(ctx, 1, 5);
    expect(ticket.attributes).toMatchObject({ routing_seen: 300, routing_handled: 250 });
  });

  it("does not rewrite equivalent Text-definition watermarks", async () => {
    const ticket: Ticket = { attributes: { routing_seen: "1", routing_handled: "1", routing_kind: "spam" } };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["spam", 1] });
    const ctx = context(new MapStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    await routeConversation(ctx, 1, 5);
    expect(sent(requests, "POST", `${CW}/custom_attributes`)).toEqual([]);
    expect(ticket.attributes).toEqual({ routing_seen: "1", routing_handled: "1", routing_kind: "spam" });
  });

  it("marks a no-owner decision seen and preserves unrelated attributes", async () => {
    const ticket: Ticket = { attributes: { discord_thread: "https://discord.com/channels/1/2" } };
    world(ticket, { owner: ["unclear", 1], topic: ["billing", 1] });
    await routeConversation(context(), 1, 5);
    expect(ticket.attributes).toEqual({ discord_thread: "https://discord.com/channels/1/2", routing_seen: 1 });
  });

  it("retries attribute persistence after a kind replies, without replying or classifying twice", async () => {
    const ticket: Ticket = { failAttributes: 1 };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
    expect(ticket.attributes).toBeUndefined();
    await routeConversation(ctx, 1, 5);
    expect(ticket.attributes).toEqual({ routing_seen: 1, routing_handled: 1, routing_kind: "startup-program" });
    expect(replies(requests)).toHaveLength(1);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it("never applies a recorded decision at or below the account's cutover id", async () => {
    const { requests } = world({}, { owner: ["cloud", 1], topic: ["billing", 1] }, 1);
    const ctx = context();
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow();
    const before = sent(requests, "POST", `${CW}/assignments`).length;
    ctx.settings.config.startAfterConversationId = { "1": 5 };
    await routeConversation(ctx, 1, 5);
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(before);
    expect(sent(requests, "POST", `${CW}/custom_attributes`)).toHaveLength(1);
  });
});

describe("per-account cutover", () => {
  it.each([
    { cutover: { "1": 5, "2": 1 }, eligible: false },
    { cutover: { "1": 6, "2": 1 }, eligible: false },
    { cutover: { "1": 4, "2": 100 }, eligible: true },
    { cutover: { "2": 100 }, eligible: true },
    { cutover: {}, eligible: true },
  ])("uses only the current account's cutoff %j", async ({ cutover, eligible }) => {
    const { requests } = world({}, { owner: ["cloud", 1], topic: ["billing", 1] });
    const store = new MapStore();
    const settings = testSettings(
      {
        routing: { ...ROUTING, accounts: { "1": ROUTING.accounts["1"], "2": ROUTING.accounts["1"] } },
        startAfterConversationId: cutover,
      },
      { CHATWOOT_WEBHOOK_SECRETS: '{"1":"secret-acme","2":"secret-globex"}' },
    );
    await routeConversation({ ...context(store), settings }, 1, 5);
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(eligible ? 1 : 0);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(eligible ? 1 : 0);
  });
});

describe("sanitize", () => {
  it("redacts identifiers before contact names can split them", () => {
    expect(sanitize("example@example.com", ["Example Customer"])).toBe("[REDACTED]");
  });
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
      "(MAC aa:bb:cc:dd:ee:ff, v1.2.3.4, build 1.2.3.4.5, std::vec). My IP is 10.1.2.3. " +
      "remote_addr:203.0.113.8 ip:2001:db8::1 upstream 198.51.100.7:443 client:198.51.100.9:http fe80::1:abcd";
    expect(sanitize(text, [])).toBe(
      "from [REDACTED], [REDACTED], [REDACTED], and [REDACTED] at 10:30:00 " +
        "(MAC aa:bb:cc:dd:ee:ff, v1.2.3.4, build 1.2.3.4.5, std::vec). My IP is [REDACTED]. " +
        "remote_addr:[REDACTED] ip:[REDACTED] upstream [REDACTED]:443 client:[REDACTED]:http [REDACTED]",
    );
  });
});
