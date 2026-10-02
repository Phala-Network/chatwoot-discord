import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, BudgetExhaustedError } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
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

class MapStore implements RoutingStore {
  values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  list(prefix: string) {
    return [...this.values].flatMap(([key, value]) => (key.startsWith(prefix) ? [value] : []));
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
  failRead?: number;
  failMessages?: number;
  failCanned?: number;
  failJev?: number;
  loseLabelsAnswer?: number;
  loseReplyAnswer?: number;
  loseAttributesAnswer?: number;
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
      if ((ticket.failRead ?? 0) > 0) {
        ticket.failRead = (ticket.failRead ?? 0) - 1;
        return json({}, { status: 503 });
      }
      return json(conversation());
    }),
    on("GET", `${CW}/messages`, (request) => {
      if ((ticket.failMessages ?? 0) > 0) {
        ticket.failMessages = (ticket.failMessages ?? 0) - 1;
        return json({}, { status: 503 });
      }
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
      if ((ticket.loseLabelsAnswer ?? 0) > 0) {
        ticket.loseLabelsAnswer = (ticket.loseLabelsAnswer ?? 0) - 1;
        return json({}, { status: 503 });
      }
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
      if ((ticket.loseAttributesAnswer ?? 0) > 0) {
        ticket.loseAttributesAnswer = (ticket.loseAttributesAnswer ?? 0) - 1;
        return json({}, { status: 503 });
      }
      return json({});
    }),
    on("GET", "chatwoot.example.com/api/v1/accounts/1/canned_responses", () => {
      if ((ticket.failCanned ?? 0) > 0) {
        ticket.failCanned = (ticket.failCanned ?? 0) - 1;
        return json({}, { status: 503 });
      }
      return json([
        { id: 1, short_code: "startup", content: "Hello" },
        { id: 2, short_code: "startup-program", content: "Thanks for applying!" },
        { id: 3, short_code: "security", content: "Please report it to security@example.com." },
      ]);
    }),
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
      if ((ticket.loseReplyAnswer ?? 0) > 0) {
        ticket.loseReplyAnswer = (ticket.loseReplyAnswer ?? 0) - 1;
        return json({}, { status: 503 });
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
      if ((ticket.failJev ?? 0) > 0) {
        ticket.failJev = (ticket.failJev ?? 0) - 1;
        return json({}, { status: 503 });
      }
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

describe("level-triggered reconciliation", () => {
  it("memoizes each input window even after assignment and completion", async () => {
    const ticket: Ticket = { messages: [{ id: 1, content: "My invoice is wrong", message_type: 0 }] };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    const ctx = context();
    await routeConversation(ctx, 1, 5);
    ticket.messages?.push({ id: 2, content: "Please correct the invoice", message_type: 0 });
    await routeConversation(ctx, 1, 5);
    await routeConversation(ctx, 1, 5);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(2);
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
    expect(ticket.attributes?.routing_seen).toBe(2);
  });

  it("reconciles lost labels and attributes from observations without replaying a reply", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    ticket.labels = [];
    ticket.attributes = { discord_thread: "https://discord.com/channels/1/2" };
    await routeConversation(ctx, 1, 5);
    expect(ticket.labels).toEqual(["billing", "startup-program"]);
    expect(ticket.attributes).toMatchObject({ routing_seen: 1, routing_handled: 1, routing_kind: "startup-program" });
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(1);
  });

  it("does not snooze a human reopening twice for the same input window", async () => {
    const ticket: Ticket = { messages: [{ id: 1, content: "Hello there", message_type: 0 }] };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0] });
    const ctx = context(new MapStore(), { ...ROUTING, snoozeUnclear: true });
    await routeConversation(ctx, 1, 5);
    ticket.status = "open";
    await routeConversation(ctx, 1, 5);
    expect(ticket.status).toBe("open");
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it("does not let empty or identifier-only messages consume the text window", async () => {
    const ticket: Ticket = {
      messages: ["", "jane@example.com", "", "My invoice is wrong"].map((content, index) => ({
        id: index + 1,
        content,
        message_type: 0,
      })),
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    await routeConversation(context(), 1, 5);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(ticket.assignee?.id).toBe(6);
    expect(ticket.attributes?.routing_seen).toBe(4);
  });
});

describe("reconciliation scenarios", () => {
  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "recovers a 503 at request %s of a maximal run, including every read and write",
    async (failedRequest) => {
      const ticket: Ticket = {
        messages: Array.from({ length: 201 }, (_, index) => ({
          id: index + 1,
          content: "Request",
          message_type: index % 100 === 0 ? 0 : 1,
        })),
      };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
      const ctx = context(new MapStore(), KINDS);
      let count = 0;
      const fetch = async (request: Request) => {
        count += 1;
        return count === failedRequest ? json({}, { status: 503 }) : ctx.fetch(request);
      };
      const failing = {
        ...ctx,
        fetch,
        chatwoot: chatwootClient(ctx.settings.config.chatwoot.baseUrl, "agent-token", fetch),
      };
      await expect(routeConversation(failing, 1, 5)).rejects.toThrow("503");
      await routeConversation(failing, 1, 5);
      await routeConversation(failing, 1, 5);
      expect(ticket.assignee?.id).toBe(6);
      expect(ticket.labels).toEqual(["billing", "startup-program"]);
      expect(ticket.attributes).toEqual({
        routing_seen: 201,
        routing_kind: "startup-program",
        ...(failedRequest === 11 ? {} : { routing_handled: 201 }),
      });
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
      expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(failedRequest === 11 ? 0 : 1);
    },
  );

  it("sends redacted text capped at 1600 characters and never follows Jev redirects", async () => {
    const ticket: Ticket = {
      messages: [
        {
          id: 1,
          content: `My invoice is wrong, Jane Doe at jane@example.com. ${"Please help. ".repeat(200)}`,
          message_type: 0,
        },
      ],
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    await routeConversation(context(), 1, 5);
    const request = sent(requests, "POST", "api.typesafe.ai/v1/systemone")[0];
    expect(request?.redirect).toBe("manual");
    const text = JSON.parse(request?.body ?? "{}").state.ticket;
    expect(text).toHaveLength(1600);
    expect(text).toContain("[REDACTED] at [REDACTED]");
    expect(text).not.toContain("Jane");
  });

  it("memoizes unclear inputs up to three text messages, then leaves the ticket for a person", async () => {
    const ticket: Ticket = { messages: [] };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0] });
    const ctx = context();
    for (let messageId = 1; messageId <= 5; messageId += 1) {
      ticket.messages?.push({ id: messageId, content: `Request ${messageId}`, message_type: 0 });
      await routeConversation(ctx, 1, 5);
      await routeConversation(ctx, 1, 5);
    }
    expect(ticket.attributes).toEqual({ routing_seen: 5 });
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(3);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
  });

  it("does not snooze an unclear ticket whose customer did ask for help", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0], request: ["request", 1] });
    await routeConversation(context(new MapStore(), { ...ROUTING, snoozeUnclear: true }), 1, 5);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
    expect(ticket.attributes).toEqual({ routing_seen: 1 });
  });

  it("preserves a human topic while adding the kind and repairs only the kind later", async () => {
    const ticket: Ticket = { labels: ["automation"] };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    expect(ticket.labels).toEqual(["automation", "startup-program"]);
    ticket.labels = ["manual"];
    await routeConversation(ctx, 1, 5);
    expect(ticket.labels).toEqual(["manual", "startup-program"]);
    expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(1);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it.each(["failRead", "failMessages", "failJev", "failLabels", "failCanned", "failAttributes"] as const)(
    "converges after a 503 at %s without repeating successful actions",
    async (failure) => {
      const ticket: Ticket = { [failure]: 1 };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
      const ctx = context(new MapStore(), KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
      expect(ticket.attributes?.routing_seen).toBeUndefined();
      await routeConversation(ctx, 1, 5);
      await routeConversation(ctx, 1, 5);
      expect(ticket.assignee?.id).toBe(6);
      expect(ticket.labels).toEqual(["billing", "startup-program"]);
      expect(ticket.attributes).toEqual({ routing_seen: 1, routing_handled: 1, routing_kind: "startup-program" });
      expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(1);
      expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(1);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(failure === "failJev" ? 2 : 1);
    },
  );

  it("retries an assignment 503 and compares the successful assignment on the next run", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] }, 1);
    const ctx = context();
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    await routeConversation(ctx, 1, 5);
    await routeConversation(ctx, 1, 5);
    expect(ticket.assignee?.id).toBe(6);
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(2);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it.each([
    ["loseAssignAnswer", "assignments"],
    ["loseLabelsAnswer", "labels"],
    ["loseAttributesAnswer", "custom_attributes"],
  ] as const)("recovers a lost %s response by observing Chatwoot", async (failure, action) => {
    const ticket: Ticket = { [failure]: 1 };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    await routeConversation(ctx, 1, 5);
    expect(ticket.attributes).toEqual({ routing_seen: 1, routing_handled: 1, routing_kind: "startup-program" });
    expect(sent(requests, "POST", `${CW}/${action}`)).toHaveLength(1);
    expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(1);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it.each(["failReply", "loseReplyAnswer", "failSnooze", "loseStatusAnswer"] as const)(
    "never repeats an irreversible attempt after %s",
    async (failure) => {
      const status = failure === "failSnooze" || failure === "loseStatusAnswer";
      const kind = status ? "spam" : "startup-program";
      const ticket: Ticket = { [failure]: 1 };
      const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0], kind: [kind, 1] });
      const ctx = context(new MapStore(), KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
      expect(ticket.attributes?.routing_seen).toBeUndefined();
      await routeConversation(ctx, 1, 5);
      ticket.status = "open";
      await routeConversation(ctx, 1, 5);
      expect(sent(requests, "POST", `${CW}/${status ? "toggle_status" : "messages"}`)).toHaveLength(1);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
      expect(ticket.attributes).toEqual({ routing_seen: 1, routing_kind: kind });
    },
  );

  it.each(["resolved", "snoozed", "pending", "assigned", "blocked"])(
    "only acknowledges a ticket made %s while Jev answers, then reuses the answer on reopening",
    async (change) => {
      const ticket: Ticket = {};
      const { requests } = world(
        ticket,
        { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] },
        0,
        () => {
          if (change === "assigned") ticket.assignee = { id: 9, name: "Another agent" };
          else if (change === "blocked") ticket.blocked = true;
          else ticket.status = change;
        },
      );
      const ctx = context(new MapStore(), KINDS);
      await routeConversation(ctx, 1, 5);
      expect(
        requests
          .filter((request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com")
          .map((request) => request.url.pathname.split("/").at(-1)),
      ).toEqual(["custom_attributes"]);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
      ticket.status = "open";
      ticket.assignee = null;
      ticket.blocked = false;
      await routeConversation(ctx, 1, 5);
      expect(ticket.assignee).toMatchObject({ id: 6 });
      expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(1);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    },
  );

  it.each(["resolved", "snoozed", "pending", "assigned", "blocked"])(
    "does not act or classify a ticket already %s",
    async (reason) => {
      const ticket: Ticket =
        reason === "assigned"
          ? { assignee: { id: 6, name: "Human" } }
          : reason === "blocked"
            ? { blocked: true }
            : { status: reason };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 1] });
      await routeConversation(context(new MapStore(), KINDS), 1, 5);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
      expect(sent(requests, "POST", `${CW}/messages`)).toEqual([]);
      expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
    },
  );

  it.each(["resolved", "snoozed", "pending", "assigned"])(
    "does not finish actions after labels fail and a person makes the ticket %s",
    async (change) => {
      const ticket: Ticket = { failLabels: 1 };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
      const ctx = context(new MapStore(), KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
      expect(ticket.assignee?.id).toBe(6);
      if (change === "assigned") ticket.assignee = { id: 9, name: "Human" };
      else ticket.status = change;
      await routeConversation(ctx, 1, 5);
      expect(sent(requests, "POST", `${CW}/messages`)).toEqual([]);
      expect(sent(requests, "POST", `${CW}/labels`)).toHaveLength(1);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
    },
  );

  it("snoozes, acknowledges the status webhook, and routes a customer reopening with new inputs", async () => {
    const ticket: Ticket = { messages: [{ id: 1, content: "Hello there", message_type: 0 }] };
    const answers: { owner: [string, number]; topic: [string, number] } = {
      owner: ["unclear", 1],
      topic: ["billing", 0],
    };
    const { requests } = world(ticket, answers);
    const ctx = context(new MapStore(), { ...ROUTING, snoozeUnclear: true });
    await routeConversation(ctx, 1, 5);
    expect(ticket.status).toBe("snoozed");
    await routeConversation(ctx, 1, 5);
    ticket.status = "open";
    ticket.messages?.push({ id: 2, content: "My invoice is wrong", message_type: 0 });
    answers.owner = ["cloud", 1];
    await routeConversation(ctx, 1, 5);
    expect(ticket.assignee?.id).toBe(6);
    expect(ticket.attributes).toEqual({ routing_seen: 2 });
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(2);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
  });

  it.each(["spam", "beg-bounty", "startup-program"])(
    "finishes the full input window for %s despite consecutive messages during backoff",
    async (kind) => {
      const ticket: Ticket = { failLabels: 1, messages: [{ id: 1, content: "Request 1", message_type: 0 }] };
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: [kind, 1] });
      const ctx = context(new MapStore(), KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
      for (let messageId = 2; messageId <= 5; messageId += 1)
        ticket.messages?.push({ id: messageId, content: `Request ${messageId}`, message_type: 0 });
      await routeConversation(ctx, 1, 5);
      await routeConversation(ctx, 1, 5);
      const asked = sent(requests, "POST", "api.typesafe.ai/v1/systemone");
      expect(asked).toHaveLength(2);
      expect(JSON.parse(asked.at(-1)?.body ?? "{}").state.ticket).toBe("Request 1 Request 2 Request 3");
      expect(ticket.attributes).toEqual({ routing_seen: 5, routing_handled: 3, routing_kind: kind });
      expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(kind === "spam" ? 0 : 1);
    },
  );

  it("redecides after 400 activity messages without sending the old canned response", async () => {
    const ticket: Ticket = { failLabels: 1, messages: [{ id: 1, content: "Application", message_type: 0 }] };
    const answers: { owner: [string, number]; topic: [string, number]; kind: [string, number] } = {
      owner: ["cloud", 1],
      topic: ["billing", 1],
      kind: ["startup-program", 1],
    };
    const { requests } = world(ticket, answers);
    const ctx = context(new MapStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    for (let messageId = 2; messageId <= 401; messageId += 1)
      ticket.messages?.push({ id: messageId, content: "Activity", message_type: 2 });
    ticket.messages?.push({ id: 402, content: "A different billing request", message_type: 0 });
    answers.kind = ["none", 1];
    await routeConversation(ctx, 1, 5);
    const asked = sent(requests, "POST", "api.typesafe.ai/v1/systemone");
    expect(asked).toHaveLength(2);
    expect(JSON.parse(asked.at(-1)?.body ?? "{}").state.ticket).toContain("A different billing request");
    expect(ticket.attributes).toEqual({ routing_seen: 402 });
    expect(sent(requests, "POST", `${CW}/messages`)).toEqual([]);
  });

  it.each(["spam", "beg-bounty", "none"])(
    "leaves status to a person beyond the bounded public-reply read for %s, without re-asking Jev",
    async (kind) => {
      const ticket: Ticket = {
        messages: [
          { id: 1, content: "Hello there", message_type: 0 },
          ...Array.from({ length: 400 }, (_, index) => ({ id: index + 2, content: "Public reply", message_type: 1 })),
          { id: 402, content: "Please help", message_type: 0 },
        ],
      };
      const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0], kind: [kind, 1] });
      const ctx = context(new MapStore(), { ...KINDS, snoozeUnclear: true });
      await routeConversation(ctx, 1, 5);
      await routeConversation(ctx, 1, 5);
      expect(ticket.attributes?.routing_seen).toBe(402);
      expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
      const scans = sent(requests, "GET", `${CW}/messages`).filter((request) => request.url.searchParams.has("after"));
      expect(scans).toHaveLength(6);
    },
  );

  it.each(["", "jane@example.com", "Jane Doe", "example@example.com"])(
    "acknowledges %j without Jev or snooze and later routes usable text",
    async (content) => {
      const ticket: Ticket = { name: "Example Customer", messages: [{ id: 1, content, message_type: 0 }] };
      if (content === "Jane Doe") ticket.name = "Jane Doe";
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
      const ctx = context(new MapStore(), { ...ROUTING, snoozeUnclear: true });
      await routeConversation(ctx, 1, 5);
      expect(ticket.attributes).toEqual({ routing_seen: 1 });
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toEqual([]);
      expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
      ticket.messages?.push({ id: 2, content: "My invoice is wrong", message_type: 0 });
      await routeConversation(ctx, 1, 5);
      expect(ticket.assignee?.id).toBe(6);
      expect(ticket.attributes?.routing_seen).toBe(2);
    },
  );

  it.each(["assigned", "resolved", "snoozed"])(
    "repairs lost attributes on %s tickets from memoized inputs and the outbox",
    async (status) => {
      const ticket: Ticket = {};
      const kind = status === "assigned" ? "startup-program" : "spam";
      const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: [kind, 1] });
      const ctx = context(new MapStore(), KINDS);
      await routeConversation(ctx, 1, 5);
      if (status !== "assigned") ticket.status = status;
      ticket.attributes = { discord_thread: "https://discord.com/channels/1/2" };
      await routeConversation(ctx, 1, 5);
      await routeConversation(ctx, 1, 5);
      expect(ticket.attributes).toEqual({
        discord_thread: "https://discord.com/channels/1/2",
        routing_seen: 1,
        routing_handled: 1,
        routing_kind: kind,
      });
      expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
      expect(sent(requests, "POST", `${CW}/custom_attributes`)).toHaveLength(2);
      expect(sent(requests, "POST", `${CW}/messages`)).toHaveLength(status === "assigned" ? 1 : 0);
    },
  );

  it("retains handled inputs from an earlier status window after reopening and losing attributes", async () => {
    const ticket: Ticket = {};
    const answers: { owner: [string, number]; topic: [string, number]; kind: [string, number] } = {
      owner: ["unclear", 1],
      topic: ["billing", 0],
      kind: ["spam", 1],
    };
    const { requests } = world(ticket, answers);
    const ctx = context(new MapStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    ticket.status = "open";
    ticket.messages?.push({ id: 3, content: "A real request", message_type: 0 });
    ticket.attributes = {};
    answers.kind = ["none", 1];
    await routeConversation(ctx, 1, 5);
    expect(ticket.attributes).toEqual({ routing_seen: 3, routing_handled: 1, routing_kind: "spam" });
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
  });

  it.each([1, "1", 50, "50"])("preserves equivalent or greater watermark values %j without a write", async (value) => {
    const ticket: Ticket = { attributes: { routing_seen: value, routing_handled: value, routing_kind: "spam" } };
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0] });
    await routeConversation(context(), 1, 5);
    expect(ticket.attributes?.routing_seen).toBe(value);
    expect(sent(requests, "POST", `${CW}/custom_attributes`)).toEqual([]);
  });

  it.each([null, {}, "invalid", -1, true])("replaces absent or invalid watermark %j", async (value) => {
    const ticket: Ticket = { attributes: { routing_seen: value, unrelated: "kept" } };
    world(ticket, { owner: ["unclear", 1], topic: ["billing", 0] });
    await routeConversation(context(), 1, 5);
    expect(ticket.attributes).toEqual({ routing_seen: 1, unrelated: "kept" });
  });

  it.each([
    { cutover: { "1": 5 }, eligible: false },
    { cutover: { "1": 4 }, eligible: true },
    { cutover: { "2": 100 }, eligible: true },
    { cutover: {}, eligible: true },
  ])("uses only the current account's cutover %j", async ({ cutover, eligible }) => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    const settings = testSettings(
      {
        routing: { ...ROUTING, accounts: { "1": ROUTING.accounts["1"], "2": ROUTING.accounts["1"] } },
        startAfterConversationId: cutover,
      },
      { CHATWOOT_WEBHOOK_SECRETS: '{"1":"secret-acme","2":"secret-globex"}' },
    );
    await routeConversation({ ...context(), settings }, 1, 5);
    expect(ticket.attributes).toEqual({ routing_seen: 1 });
    expect(sent(requests, "POST", `${CW}/assignments`)).toHaveLength(eligible ? 1 : 0);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(eligible ? 1 : 0);
  });

  it.each([false, true])("fits the actual worst-case request boundary: sufficient=%s", async (sufficient) => {
    const ticket: Ticket = {
      messages: Array.from({ length: 201 }, (_, index) => ({
        id: index + 1,
        content: "Request",
        message_type: index % 100 === 0 ? 0 : 1,
      })),
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["startup-program", 1] });
    const ctx = context(new MapStore(), KINDS);
    const budget = new Budget(ROUTE_BUDGET - (sufficient ? 0 : 1), ctx.fetch);
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
      expect(ticket.attributes).toEqual({ routing_seen: 201, routing_handled: 201, routing_kind: "startup-program" });
    } else {
      await expect(run).rejects.toBeInstanceOf(BudgetExhaustedError);
      expect(ticket.attributes).toBeUndefined();
    }
    expect(requests).toHaveLength(ROUTE_BUDGET - (sufficient ? 0 : 1));
    expect(budget.remaining).toBe(0);
  });

  it("filters internal messages for routing but leaves the relay's reads unchanged", async () => {
    const ticket: Ticket = {
      messages: [
        { id: 1, content: "Activity", message_type: 2 },
        { id: 2, content: "Private note", message_type: 1, private: true },
        { id: 3, content: "Invoice", message_type: 0 },
      ],
    };
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1] });
    const ctx = context();
    await routeConversation(ctx, 1, 5);
    expect(
      sent(requests, "GET", `${CW}/messages`).every(
        (request) => request.url.searchParams.get("filter_internal_messages") === "true",
      ),
    ).toBe(true);
    expect(await ctx.chatwoot.listMessages(1, 5)).toHaveLength(3);
    expect(requests.at(-1)?.url.searchParams.has("filter_internal_messages")).toBe(false);
  });

  it("reads canned text at send time as the account bot and publishes attributes last", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["cloud", 1], topic: ["billing", 1], kind: ["beg-bounty", 1] });
    await routeConversation(context(new MapStore(), KINDS), 1, 5);
    const actions = requests.filter(
      (request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com",
    );
    expect(actions.map((request) => request.url.pathname.split("/").at(-1))).toEqual([
      "labels",
      "messages",
      "toggle_status",
      "custom_attributes",
    ]);
    const reply = sent(requests, "POST", `${CW}/messages`)[0];
    expect(reply?.headers.get("api_access_token")).toBe("bot-token");
    expect(JSON.parse(reply?.body ?? "{}").content).toBe("Please report it to security@example.com.");
    expect(ticket.status).toBe("resolved");
    expect(ticket.attributes).toEqual({ routing_seen: 1, routing_handled: 1, routing_kind: "beg-bounty" });
  });

  it("retries a missing canned response without recording a reply attempt", async () => {
    const ticket: Ticket = {};
    const { requests } = world(ticket, { owner: ["unclear", 1], topic: ["billing", 0], kind: ["security", 1] });
    const ctx = context(new MapStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("canned response is missing");
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("canned response is missing");
    expect(sent(requests, "POST", `${CW}/messages`)).toEqual([]);
    expect(sent(requests, "POST", "api.typesafe.ai/v1/systemone")).toHaveLength(1);
    expect(ticket.attributes).toBeUndefined();
  });

  it("keeps automation labels and ignores low-confidence owner, topic, and kind choices", async () => {
    const ticket: Ticket = { labels: ["automation"] };
    const { requests } = world(ticket, { owner: ["cloud", 0.6], topic: ["billing", 0.6], kind: ["spam", 0.6] });
    await routeConversation(context(new MapStore(), KINDS), 1, 5);
    expect(ticket.labels).toEqual(["automation"]);
    expect(sent(requests, "POST", `${CW}/assignments`)).toEqual([]);
    expect(sent(requests, "POST", `${CW}/toggle_status`)).toEqual([]);
    expect(ticket.attributes).toEqual({ routing_seen: 1 });
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
