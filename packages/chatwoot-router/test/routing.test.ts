import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { routeConversation } from "../src/routing.ts";
import { expectActivity, recordFailure, requestHandoff } from "../src/turn.ts";
import {
  activity,
  CW,
  context,
  incoming,
  JEV,
  KINDS,
  MemoryStore,
  ROUTING,
  sent,
  type Ticket,
  world,
} from "./world.ts";

afterEach(() => vi.restoreAllMocks());

async function jevInput(text: string, identities: string[]): Promise<string> {
  const mock = world({ name: identities[0] ?? "Jane Doe", messages: [incoming(1, `Request: ${text}`)] });
  await routeConversation(context(), 1, 5);
  return JSON.parse(sent(mock.requests, "POST", JEV)[0]?.body ?? "{}").state.ticket.replace(/^Request: /, "");
}

describe("Jev input privacy", async () => {
  it("redacts identifiers before contact names can split them", async () => {
    expect(await jevInput("example@example.com", ["Example Customer"])).toBe("[REDACTED]");
  });
  it("removes identifiers", async () => {
    const text =
      "Hi, I'm Alice Chen (alice.chen@example.com, +1 415-555-0199). See https://cloud.example.com/x; " +
      "wallet 0x52908400098527886E0F7030069857D2E4169EE7 and 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY, " +
      "key Zq9x_abcdefghijklmnopqrstuvwxyz0123456789ABCD, ip 10.1.2.3, ping @alicec. Thanks, Alice";
    expect(await jevInput(text, ["Alice Chen", "alice.chen@example.com"])).toBe(
      "Hi, I'm [REDACTED] ([REDACTED], [REDACTED]). See [REDACTED] wallet [REDACTED] and [REDACTED], " +
        "key [REDACTED], ip [REDACTED], ping [REDACTED] Thanks, [REDACTED]",
    );
  });

  it("removes IP addresses, but not times, MAC addresses, versions, or paths", async () => {
    const text =
      "from 2001:db8::1, 2001:db8:1234::192.0.2.1, ::ffff:198.51.100.7, and fe80::1%eth0 at 10:30:00 " +
      "(MAC aa:bb:cc:dd:ee:ff, v1.2.3.4, build 1.2.3.4.5, std::vec). My IP is 10.1.2.3. " +
      "remote_addr:203.0.113.8 ip:2001:db8::1 upstream 198.51.100.7:443 client:198.51.100.9:http fe80::1:abcd";
    expect(await jevInput(text, [])).toBe(
      "from [REDACTED], [REDACTED], [REDACTED], and [REDACTED] at 10:30:00 " +
        "(MAC aa:bb:cc:dd:ee:ff, v1.2.3.4, build 1.2.3.4.5, std::vec). My IP is [REDACTED]. " +
        "remote_addr:[REDACTED] ip:[REDACTED] upstream [REDACTED]:443 client:[REDACTED]:http [REDACTED]",
    );
  });
});

describe("native bot turns", () => {
  it.each(["open", "resolved", "snoozed"])(
    "releases the brand bot from %s without changing status or sending messages",
    async (status) => {
      const mock = world({ status, bot: null });
      await routeConversation(context(), 1, 5);
      await routeConversation(context(), 1, 5);
      expect(mock.ticket.status).toBe(status);
      expect(mock.ticket.assignee).toBeNull();
      const mutations = mock.requests.filter((request) => request.method === "POST");
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.url.pathname).toBe("/api/v1/accounts/1/conversations/5/assignments");
      expect(mutations[0]?.body).toBe(JSON.stringify({ assignee_id: null }));
      expect(mutations[0]?.headers.get("api_access_token")).toBe("bot-token");
    },
  );

  it.each(["person", "other bot", "pending"])(
    "preserves a %s takeover while releasing a non-pending brand bot",
    async (change) => {
      let reads = 0;
      const mock = world({
        status: "open",
        during: (operation) => {
          if (operation !== "read" || ++reads !== 2) return;
          if (change === "pending") mock.ticket.status = "pending";
          else {
            mock.ticket.assigneeType = change === "person" ? "User" : "AgentBot";
            mock.ticket.assignee = { id: 6 };
          }
        },
      });
      await routeConversation(context(), 1, 5);
      expect(mock.requests.filter((request) => request.method === "POST")).toEqual([]);
      expect(mock.ticket.status).toBe(change === "pending" ? "pending" : "open");
      if (change !== "pending") expect(mock.ticket.assignee?.id).toBe(6);
    },
  );

  it("retries a failed non-pending bot release without routing", async () => {
    const mock = world({ status: "open", fail: { assignments: 1 } });
    const ctx = context();
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(mock.ticket.assignee).toBeNull();
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
    expect(sent(mock.requests, "POST", `${CW}/assignments`)).toHaveLength(2);
  });
  it("calls the configured deployment of TypeSafe's System One API", async () => {
    const endpoint = "jev.example.com/custom/systemone";
    const mock = world({}, { owner: ["sales", 1] }, endpoint);
    const ctx = context(new MemoryStore(), { ...ROUTING, endpoint: `https://${endpoint}` });
    await routeConversation(ctx, 1, 5);
    expect(sent(mock.requests, "POST", endpoint)).toHaveLength(1);
    expect(sent(mock.requests, "POST", endpoint)[0]?.url.href).toBe(`https://${endpoint}`);
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
    expect(mock.ticket.assignee?.id).toBe(7);
    expect(mock.ticket.status).toBe("open");
  });

  it.each(["startup", "bounty", "spam", "newsletter"])(
    "applies %s in order as the bot and stops after the ending action",
    async (kind) => {
      const mock = world({}, { owner: ["cloud", 1], kind: [kind, 1] });
      const ctx = context(new MemoryStore(), KINDS);
      await routeConversation(ctx, 1, 5);
      const mutations = mock.requests.filter(
        (request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com",
      );
      expect(mutations.map((request) => request.url.pathname.split("/").at(-1))).toEqual([
        "labels",
        ...(["startup", "bounty"].includes(kind) ? ["messages"] : []),
        kind === "startup" ? "assignments" : "toggle_status",
      ]);
      expect(mutations.every((request) => request.headers.get("api_access_token") === "bot-token")).toBe(true);
      expect(sent(mock.requests, "POST", JEV)).toHaveLength(1);
      expect(mock.ticket.status).toBe(kind === "startup" ? "open" : kind === "newsletter" ? "snoozed" : "resolved");
    },
  );

  it.each(["open", "snoozed", "resolved", "person", "blocked", "other-bot"])(
    "leaves %s conversations alone",
    async (reason) => {
      const ticket: Ticket = {};
      if (["open", "snoozed", "resolved"].includes(reason)) {
        ticket.status = reason;
        ticket.assignee = null;
        ticket.assigneeType = null;
      }
      if (reason === "person") {
        ticket.assignee = { id: 1 };
        ticket.assigneeType = "User";
      }
      if (reason === "blocked") ticket.blocked = true;
      if (reason === "other-bot") {
        ticket.assignee = { id: 99 };
        ticket.assigneeType = "AgentBot";
      }
      const mock = world(ticket);
      await routeConversation(context(), 1, 5);
      expect(mock.requests.filter((request) => request.method === "POST")).toEqual([]);
    },
  );

  it("rejects a foreign account's bot without mutations", async () => {
    const mock = world({ bot: { id: 1, account_id: 2 } });
    await expect(routeConversation(context(), 1, 5)).rejects.toThrow("does not belong");
    expect(mock.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it.each(["disconnect", "replacement"])("hands off a %s without reading a turn or calling Jev", async (reason) => {
    const mock = world({ bot: reason === "disconnect" ? null : { id: 99, account_id: 1 } });
    await routeConversation(context(), 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(mock.ticket.assignee).toBeNull();
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
    expect(sent(mock.requests, "GET", `${CW}/messages`)).toEqual([]);
    expect(sent(mock.requests, "POST", `${CW}/toggle_status`)[0]?.headers.get("api_access_token")).toBe("bot-token");
  });

  it.each(["person", "other bot", "unassigned", "open"])(
    "leaves a disconnected %s ticket untouched",
    async (reason) => {
      const ticket: Ticket = { bot: null };
      if (reason === "person") {
        ticket.assigneeType = "User";
        ticket.assignee = { id: 6 };
      }
      if (reason === "other bot") ticket.assignee = { id: 99 };
      if (reason === "unassigned") {
        ticket.assignee = null;
        ticket.assigneeType = null;
      }
      if (reason === "open") {
        ticket.status = "open";
        ticket.assignee = null;
        ticket.assigneeType = null;
      }
      const mock = world(ticket);
      await routeConversation(context(), 1, 5);
      expect(mock.requests.filter((request) => request.method === "POST")).toEqual([]);
    },
  );

  it("hands off a disconnected brand bot's blocked pending ticket without sending", async () => {
    const mock = world({ bot: null, blocked: true });
    await routeConversation(context(), 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toEqual([]);
  });

  it("retries a failed disconnect handoff without classifying", async () => {
    const mock = world({ bot: null, fail: { toggle_status: 1 } });
    const ctx = context();
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
    expect(sent(mock.requests, "POST", `${CW}/toggle_status`)).toHaveLength(2);
  });

  it.each(["open", "resolved", "snoozed", "person", "blocked", "unlinked"])(
    "respects a %s change while Jev answers",
    async (change) => {
      const ticket: Ticket = {
        during: (operation) => {
          if (operation !== "jev") return;
          if (change === "person") {
            ticket.assignee = { id: 1 };
            ticket.assigneeType = "User";
          } else if (change === "blocked") ticket.blocked = true;
          else if (change === "unlinked") ticket.bot = null;
          else ticket.status = change;
        },
      };
      const mock = world(ticket, { owner: ["cloud", 1], kind: ["bounty", 1] });
      await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
      const mutations = mock.requests.filter(
        (request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com",
      );
      const ended = ["open", "resolved", "snoozed"].includes(change);
      expect(mutations).toHaveLength(change === "unlinked" || ended ? 1 : 0);
      if (ended) {
        expect(mutations[0]?.body).toBe(JSON.stringify({ assignee_id: null }));
        expect(ticket.status).toBe(change);
        expect(ticket.assignee).toBeNull();
      }
      if (change === "unlinked") expect(ticket.status).toBe("open");
    },
  );

  it.each(["jev", "labels", "messages"])(
    "hands off after a person's public reply during %s, without subsequent planned actions",
    async (stage) => {
      const ticket: Ticket = {
        during: (operation) => {
          if (operation === stage)
            ticket.messages?.push({ id: 80, content: "I am helping", message_type: 1, sender: { type: "user" } });
        },
      };
      const mock = world(ticket, { owner: ["cloud", 1], kind: ["bounty", 1] });
      await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
      expect(ticket.status).toBe("open");
      expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(stage === "messages" ? 1 : 0);
      expect(sent(mock.requests, "POST", `${CW}/assignments`)).toHaveLength(0);
    },
  );

  it("ignores private human notes and activities as input or public takeover", async () => {
    const mock = world({
      messages: [
        { id: 1, message_type: 2 },
        { id: 2, message_type: 1, private: true, sender: { type: "user" }, content: "Note" },
        incoming(3),
      ],
    });
    await routeConversation(context(), 1, 5);
    expect(mock.ticket.assignee).toMatchObject({ id: 6 });
    expect(JSON.parse(sent(mock.requests, "POST", JEV)[0]?.body ?? "{}").state.ticket).toBe(
      "Please help with my invoice",
    );
  });

  it("hands off an unassigned reopened conversation without leaving a person stuck pending", async () => {
    const mock = world({ assignee: null, assigneeType: null, messages: [activity(1), incoming(2)] });
    await routeConversation(context(), 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/assignments`)).toEqual([]);
  });

  it("keeps greetings pending, memoizes the window, then decides again on a request", async () => {
    const mock = world({ messages: [incoming(1, "Hello there")] }, { owner: ["unclear", 1], request: ["none", 1] });
    const ctx = context();
    await routeConversation(ctx, 1, 5);
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("pending");
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(1);
    mock.ticket.messages?.push(incoming(2));
    mock.answers.request = ["request", 1];
    mock.answers.owner = ["cloud", 1];
    await routeConversation(ctx, 1, 5);
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(2);
    expect(mock.ticket.status).toBe("open");
  });

  it("hands off three greeting texts or an unclear actual request", async () => {
    const mock = world(
      { messages: [incoming(1, "Hi"), incoming(2, "Hello"), incoming(3, "Anyone there")] },
      { owner: ["unclear", 1], request: ["none", 1] },
    );
    await routeConversation(context(), 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/toggle_status`)).toHaveLength(1);
  });

  it("abandons a stale no-request decision when input changes during Jev", async () => {
    const ticket: Ticket = {
      messages: [incoming(1, "Hello")],
      during: (operation) => {
        if (operation === "jev") ticket.messages?.push(incoming(2));
      },
    };
    const mock = world(ticket, { owner: ["unclear", 1], request: ["none", 1] });
    expect(await routeConversation(context(), 1, 5)).toBe("defer");
    expect(
      mock.requests.filter((request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com"),
    ).toEqual([]);
  });

  it.each(["", "jane@example.com", "Jane Doe", "0x52908400098527886E0F7030069857D2E4169EE7"])(
    "hands off empty or identifier-only %j without Jev",
    async (content) => {
      const mock = world({ messages: [incoming(1, content)] });
      await routeConversation(context(), 1, 5);
      expect(sent(mock.requests, "POST", JEV)).toEqual([]);
      expect(mock.ticket.status).toBe("open");
    },
  );

  it("does not consume the three-text window with empty, automatic, deleted, or identifier messages", async () => {
    const mock = world({
      messages: [
        incoming(1, ""),
        incoming(2, "jane@example.com"),
        { ...incoming(3), content_attributes: { deleted: true } },
        { ...incoming(4), content_attributes: { email: { auto_reply: true } } },
        incoming(5, "First request"),
        incoming(6, "Second request"),
        incoming(7, "Third request"),
        incoming(8, "Fourth"),
      ],
    });
    await routeConversation(context(), 1, 5);
    expect(JSON.parse(sent(mock.requests, "POST", JEV)[0]?.body ?? "{}").state.ticket).toBe(
      "First request Second request Third request",
    );
  });

  it("redacts and caps Jev input, including the email subject and excluding quoted history", async () => {
    const mock = world({
      messages: [
        {
          ...incoming(1, "Old private email history"),
          content_attributes: {
            email: { subject: "Invoice jane@example.com", text_content: { quoted: "Help ".repeat(500) } },
          },
        },
      ],
    });
    await routeConversation(context(), 1, 5);
    const request = sent(mock.requests, "POST", JEV)[0];
    const text = JSON.parse(request?.body ?? "{}").state.ticket;
    expect(text).toHaveLength(1600);
    expect(text).toMatch(/^Invoice \[REDACTED\]/);
    expect(text).not.toContain("history");
    expect(request?.redirect).toBe("manual");
  });

  it("preserves human labels while adding the kind, and retries failed labels without reclassifying", async () => {
    const mock = world({ labels: ["human-topic"], fail: { labels: 1 } }, { owner: ["cloud", 1], kind: ["startup", 1] });
    const ctx = context(new MemoryStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.labels).toEqual(["human-topic", "startup"]);
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(1);
  });

  it("redecides when messages arrive during failure backoff, using only three texts", async () => {
    const mock = world({ fail: { labels: 1 }, messages: [incoming(1, "First")] });
    const ctx = context();
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    mock.ticket.messages?.push(incoming(2, "Second"), incoming(3, "Third"), incoming(4, "Fourth"));
    await routeConversation(ctx, 1, 5);
    const calls = sent(mock.requests, "POST", JEV);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? "{}").state.ticket).toBe("First Second Third");
  });

  it("does not overwrite human changes while a failed mutation backs off", async () => {
    const mock = world({ fail: { labels: 1 } });
    const ctx = context();
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    mock.ticket.status = "open";
    mock.ticket.labels = [];
    mock.ticket.assignee = null;
    await routeConversation(ctx, 1, 5);
    expect(sent(mock.requests, "POST", `${CW}/labels`)).toHaveLength(1);
    expect(sent(mock.requests, "POST", `${CW}/assignments`)).toHaveLength(0);
  });

  it.each(["labels", "assignments", "toggle_status"])(
    "recovers a lost %s response without duplicate observable effects",
    async (operation) => {
      const mock = world(
        { lose: { [operation]: 1 } },
        { owner: ["cloud", 1], kind: [operation === "assignments" ? "startup" : "bounty", 1] },
      );
      const ctx = context(new MemoryStore(), KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
      await routeConversation(ctx, 1, 5);
      expect(sent(mock.requests, "POST", `${CW}/${operation}`)).toHaveLength(1);
      expect(sent(mock.requests, "POST", JEV)).toHaveLength(1);
    },
  );

  it("retries assignment failures and never sends another reply", async () => {
    const mock = world({ fail: { assignments: 1 } }, { owner: ["cloud", 1], kind: ["startup", 1] });
    const ctx = context(new MemoryStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
    expect(sent(mock.requests, "POST", `${CW}/assignments`)).toHaveLength(2);
  });

  it.each(["read", "messages-read", "jev", "canned", "toggle_status"])(
    "recovers a transient %s failure and completes the turn with one reply",
    async (operation) => {
      const mock = world({ fail: { [operation]: 1 } }, { owner: ["cloud", 1], kind: ["bounty", 1] });
      const ctx = context(new MemoryStore(), KINDS);
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
      await routeConversation(ctx, 1, 5);
      expect(mock.ticket.status).toBe("resolved");
      expect(mock.ticket.labels).toEqual(["bounty"]);
      expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
      expect(sent(mock.requests, "POST", JEV)).toHaveLength(operation === "jev" ? 2 : 1);
    },
  );

  it.each(["resolved", "snoozed"])(
    "hands off an unconfirmed reply without applying %s or resending",
    async (status) => {
      const mock = world({ fail: { messages: 1 } }, { owner: ["cloud", 1], kind: ["bounty", 1] });
      const ctx = context(new MemoryStore(), {
        ...KINDS,
        kinds: { "1": { ...KINDS.kinds["1"], bounty: { ...KINDS.kinds["1"].bounty, status } } },
      });
      await routeConversation(ctx, 1, 5);
      await routeConversation(ctx, 1, 5);
      expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
      expect(mock.ticket.status).toBe("open");
      expect(sent(mock.requests, "POST", `${CW}/toggle_status`).map((request) => JSON.parse(request.body))).toEqual([
        { status: "open" },
      ]);
    },
  );

  it("hands off a lost reply response even if Chatwoot committed the message", async () => {
    const mock = world({ lose: { messages: 1 } }, { owner: ["cloud", 1], kind: ["bounty", 1] });
    const ctx = context(new MemoryStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
    expect(sent(mock.requests, "POST", `${CW}/toggle_status`).map((request) => JSON.parse(request.body))).toEqual([
      { status: "open" },
    ]);
  });

  it.each(["historical relay", "restart after POST"])("uses a confirmed %s reply across turns", async (source) => {
    const mock = world(
      {
        messages: [
          { id: 1, message_type: 1, private: false, sender: { type: "agent_bot", id: 1 } },
          activity(2),
          incoming(3, "A new report"),
        ],
      },
      { owner: ["cloud", 1], kind: ["bounty", 1] },
    );
    const ctx = context(new MemoryStore(), KINDS);
    if (source === "restart after POST") ctx.store.set("reply:1:5", "attempted");
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("resolved");
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toEqual([]);
    expect(sent(mock.requests, "GET", "chatwoot.example.com/api/v1/accounts/1/canned_responses")).toEqual([]);
  });

  it.each(["failed", "deleted", "no sender", "no visibility", "no bot id", "bounded", "read failure"])(
    "hands off %s reply history without sending or resolving",
    async (reason) => {
      const reply = { id: 1, message_type: 1, private: false, sender: { type: "agent_bot", id: 1 } };
      const messages = [reply, activity(2), incoming(3)];
      if (reason === "bounded")
        messages.splice(
          1,
          2,
          ...Array.from({ length: 100 }, (_, i) => ({ id: i + 2, message_type: 2 })),
          activity(102),
          incoming(103),
        );
      const ticket: Ticket = { messages };
      if (reason === "failed") Object.assign(reply, { status: "failed" });
      if (reason === "deleted") Object.assign(reply, { content_attributes: { deleted: true } });
      if (reason === "no sender") Object.assign(reply, { sender: null });
      if (reason === "no visibility") Object.assign(reply, { private: null });
      if (reason === "no bot id") Object.assign(reply, { sender: { type: "agent_bot" } });
      if (reason === "read failure")
        ticket.during = (operation) => {
          if (operation === "labels") ticket.fail = { "messages-read": 1 };
        };
      const mock = world(ticket, { owner: ["cloud", 1], kind: ["bounty", 1] });
      await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
      expect(mock.ticket.status).toBe("open");
      expect(sent(mock.requests, "POST", `${CW}/messages`)).toEqual([]);
    },
  );

  it.each(["private", "different bot", "template", "user with same id"])(
    "does not count a %s message as a brand bot reply",
    async (reason) => {
      const reply = { id: 1, message_type: 1, private: false, sender: { type: "agent_bot", id: 1 } };
      if (reason === "private") reply.private = true;
      if (reason === "different bot") reply.sender.id = 2;
      if (reason === "template") reply.message_type = 3;
      if (reason === "user with same id") reply.sender.type = "user";
      const mock = world({ messages: [reply, activity(2), incoming(3)] }, { owner: ["cloud", 1], kind: ["bounty", 1] });
      await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
      expect(mock.ticket.status).toBe("resolved");
      expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
    },
  );

  it("finds an older brand reply on the fifth page beyond the current turn", async () => {
    const mock = world(
      {
        messages: [
          { id: 1, message_type: 1, private: false, sender: { type: "agent_bot", id: 1 } },
          ...Array.from({ length: 80 }, (_, i) => ({ id: i + 2, message_type: 2 })),
          activity(82),
          incoming(83),
        ],
      },
      { owner: ["cloud", 1], kind: ["bounty", 1] },
    );
    await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
    expect(mock.ticket.status).toBe("resolved");
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toEqual([]);
  });

  it("does not resend an observed historical reply that later disappears", async () => {
    const mock = world(
      {
        messages: [
          { id: 1, message_type: 1, private: false, sender: { type: "agent_bot", id: 1 } },
          activity(2),
          incoming(3),
        ],
      },
      { owner: ["cloud", 1], kind: ["bounty", 1] },
    );
    const ctx = context(new MemoryStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    mock.ticket.messages = (mock.ticket.messages ?? []).filter((message) => message.id !== 1);
    mock.ticket.messages?.push(incoming(5, "Another report"));
    mock.ticket.status = "pending";
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toEqual([]);
  });

  it("hands off a successful POST whose response does not confirm the brand reply", async () => {
    const mock = world(
      {
        during: (operation) => {
          if (operation === "messages") Object.assign(mock.ticket.messages?.at(-1) ?? {}, { sender: null });
        },
      },
      { owner: ["cloud", 1], kind: ["bounty", 1] },
    );
    await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
  });

  it.each(["messages", "read-messages"])("hands off a reply that fails during %s before resolving", async (stage) => {
    const mock = world(
      {
        during: (operation) => {
          if (operation !== stage) return;
          const reply = mock.ticket.messages?.find((message) => message.message_type === 1);
          if (reply) reply.status = "failed";
        },
      },
      { owner: ["cloud", 1], kind: ["bounty", 1] },
    );
    await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
    expect(sent(mock.requests, "POST", `${CW}/toggle_status`).map((request) => JSON.parse(request.body))).toEqual([
      { status: "open" },
    ]);
  });

  it("hands off immediately on a missing canned response, and keeps retrying a failed handoff", async () => {
    const mock = world({ fail: { toggle_status: 1 } }, { owner: ["cloud", 1], kind: ["security", 1] });
    const ctx = context(new MemoryStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "GET", "chatwoot.example.com/api/v1/accounts/1/canned_responses")).toHaveLength(1);
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toEqual([]);
  });

  it("ignores low confidence decisions and hands off without overwriting automation labels", async () => {
    const mock = world(
      { labels: ["automation"] },
      { owner: ["cloud", 0.6], topic: ["billing", 0.6], kind: ["spam", 0.6] },
    );
    await routeConversation(context(new MemoryStore(), KINDS), 1, 5);
    expect(mock.ticket.labels).toEqual(["automation"]);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/assignments`)).toEqual([]);
  });

  it("decides reopened resolved spam on new messages and handback on its new boundary", async () => {
    const mock = world({}, { owner: ["unclear", 1], kind: ["spam", 1] });
    const ctx = context(new MemoryStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    mock.ticket.messages?.push(incoming(3, "A real request"));
    mock.ticket.status = "pending";
    mock.answers.kind = ["none", 1];
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    mock.ticket.messages?.push(
      incoming(5, "Human-stage text"),
      activity(6, "pending"),
      incoming(7, "New handback request"),
    );
    mock.ticket.status = "pending";
    mock.ticket.assignee = { id: 1 };
    mock.ticket.assigneeType = "AgentBot";
    mock.answers.owner = ["cloud", 1];
    await routeConversation(ctx, 1, 5);
    expect(sent(mock.requests, "POST", JEV).map((request) => JSON.parse(request.body).state.ticket)).toEqual([
      "Please help with my invoice",
      "A real request",
      "New handback request",
    ]);
  });

  it("reads unfiltered history backwards to a boundary beyond the latest page", async () => {
    const mock = world({
      messages: [
        incoming(1, "Old spam"),
        activity(2),
        incoming(3, "New request"),
        ...Array.from({ length: 30 }, (_, index) => ({ id: index + 4, message_type: 2 })),
      ],
    });
    await routeConversation(context(), 1, 5);
    expect(JSON.parse(sent(mock.requests, "POST", JEV)[0]?.body ?? "{}").state.ticket).toBe("New request");
    const reads = sent(mock.requests, "GET", `${CW}/messages`);
    expect(reads.some((request) => request.url.searchParams.has("before"))).toBe(true);
    expect(reads.every((request) => !request.url.searchParams.has("filter_internal_messages"))).toBe(true);
  });

  it("waits for an expected late activity and uses it once it arrives", async () => {
    const mock = world({ messages: [incoming(1, "Old text")] });
    const ctx = context();
    expectActivity(ctx.store, 1, 5, { status: "pending", at: Date.now() / 1000 });
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("not available yet");
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
    mock.ticket.messages?.push(activity(2, "pending"), incoming(3, "New text"));
    await routeConversation(ctx, 1, 5);
    expect(JSON.parse(sent(mock.requests, "POST", JEV)[0]?.body ?? "{}").state.ticket).toBe("New text");
  });

  it("waits for a new resolution activity when the previous resolution was in the same second", async () => {
    const at = Math.floor(Date.now() / 1000);
    const mock = world(
      { messages: [incoming(1, "Old text"), { ...activity(2), created_at: at }, incoming(3, "Earlier spam")] },
      { owner: ["unclear", 1], request: ["none", 1] },
    );
    const ctx = context(new MemoryStore(), KINDS);
    expectActivity(ctx.store, 1, 5, { status: "resolved", at: at + 0.1 });
    await routeConversation(ctx, 1, 5);
    mock.ticket.messages?.push(incoming(4, "New request"));
    mock.answers.kind = ["spam", 1];
    expectActivity(ctx.store, 1, 5, { status: "resolved", at: at + 0.8 });
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("not available yet");
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(1);
    expect(mock.ticket.status).toBe("pending");

    mock.ticket.messages?.push({ ...activity(5), created_at: at }, incoming(6, "Hello again"));
    mock.answers.kind = ["none", 1];
    await routeConversation(ctx, 1, 5);
    expectActivity(ctx.store, 1, 5, { status: "resolved", at: at + 0.8 }); // Same transition redelivered.
    await routeConversation(ctx, 1, 5);
    expect(sent(mock.requests, "POST", JEV).map((request) => JSON.parse(request.body).state.ticket)).toEqual([
      "Earlier spam",
      "Hello again",
    ]);
    expect(mock.ticket.status).toBe("pending");
  });

  it("retains a known lower bound when the first timestamped webhook arrives", async () => {
    const at = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockReturnValue(at * 1000 + 100);
    const mock = world(
      {
        messages: [
          incoming(1, "Older request"),
          { ...activity(2, "resolved"), created_at: at },
          incoming(3, "Spam in the next turn"),
        ],
        during: (operation) => {
          if (operation === "toggle_status") mock.ticket.messages?.pop();
        },
      },
      { owner: ["unclear", 1], kind: ["spam", 1] },
    );
    const ctx = context(new MemoryStore(), KINDS);
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("resolved");
    expectActivity(ctx.store, 1, 5, { status: "resolved", at: at + 0.8 });
    mock.ticket.status = "pending";
    mock.ticket.messages?.push(incoming(4, "A real new request"));
    let waiting = false;
    try {
      await routeConversation(ctx, 1, 5);
    } catch (error) {
      waiting = error instanceof Error && error.name === "ActivityPendingError";
    }
    expect({ waiting, decisions: sent(mock.requests, "POST", JEV).length, status: mock.ticket.status }).toEqual({
      waiting: true,
      decisions: 1,
      status: "pending",
    });
  });

  it.each(["handback", "router resolution"])(
    "merges a late %s webhook with its already-read activity without handing off a greeting",
    async (source) => {
      const at = Math.floor(Date.now() / 1000);
      vi.spyOn(Date, "now").mockReturnValue(at * 1000 + 100);
      const mock = world({ messages: [incoming(1, "Old spam")] }, { owner: ["unclear", 1], kind: ["spam", 1] });
      const ctx = context(new MemoryStore(), KINDS);
      if (source === "router resolution") await routeConversation(ctx, 1, 5);
      else mock.ticket.messages?.push(activity(2, "pending"));
      mock.ticket.status = "pending";
      mock.ticket.messages?.push(incoming(3, "Hello"));
      mock.answers.kind = ["none", 1];
      mock.answers.request = ["none", 1];
      await routeConversation(ctx, 1, 5); // Incoming webhook/sweep reads the activity first.
      const decisions = sent(mock.requests, "POST", JEV).length;
      const status = source === "handback" ? "pending" : "resolved";
      expectActivity(ctx.store, 1, 5, { status, at: at + 0.8 });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await routeConversation(ctx, 1, 5);
          break;
        } catch {
          recordFailure(ctx.store, 1, 5);
        }
      }
      expect(mock.ticket.status).toBe("pending");
      expect(sent(mock.requests, "POST", JEV)).toHaveLength(decisions);
      // A distinct transition in that same second still needs a distinct activity.
      expectActivity(ctx.store, 1, 5, { status, at: at + 0.9 });
      await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("not available yet");
    },
  );

  it("hands off a permanently missing activity after the retry policy selects handoff", async () => {
    const mock = world();
    const ctx = context();
    expectActivity(ctx.store, 1, 5, { status: "pending", at: Date.now() / 1000 });
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("not available yet");
    requestHandoff(ctx.store, 1, 5);
    await routeConversation(ctx, 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
  });

  it.each(["deleted", "bounded"])("hands off a %s boundary without classifying old text", async (reason) => {
    const messages =
      reason === "deleted"
        ? [incoming(1), { ...activity(2), content_attributes: { deleted: true } }, incoming(3)]
        : Array.from({ length: 110 }, (_, index) => incoming(index + 1));
    const mock = world({ messages });
    const ctx = context();
    const budget = new Budget(45, ctx.fetch);
    await routeConversation(
      {
        ...ctx,
        fetch: budget.fetch,
        chatwoot: chatwootClient(ctx.settings.config.chatwoot.baseUrl, "user-token", budget.fetch),
      },
      1,
      5,
    );
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
  });

  it("hands off an owner removed from the account instead of accepting Chatwoot's silent unassignment", async () => {
    const mock = world({ agents: [] });
    await routeConversation(context(), 1, 5);
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", `${CW}/assignments`)).toEqual([]);
  });

  it("does not carry a failed old handoff or its failure limit into a new turn", async () => {
    const mock = world({ fail: { toggle_status: 1 } }, { owner: ["unclear", 1] });
    const ctx = context();
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    for (let attempt = 0; attempt < 3; attempt += 1) recordFailure(ctx.store, 1, 5);
    mock.ticket.messages?.push(activity(2, "resolved"), incoming(3, "A new request"));
    mock.answers.owner = ["cloud", 1];
    await routeConversation(ctx, 1, 5);
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(2);
    expect(mock.ticket.assignee).toMatchObject({ id: 6 });
  });

  it("does not treat customer-supplied activity metadata as a turn boundary", async () => {
    const mock = world({
      messages: [
        incoming(1, "First request"),
        {
          ...incoming(2, "Second request"),
          content_attributes: { activity: { type: "conversation_status_changed", status: "pending" } },
        },
      ],
    });
    await routeConversation(context(), 1, 5);
    expect(JSON.parse(sent(mock.requests, "POST", JEV)[0]?.body ?? "{}").state.ticket).toBe(
      "First request Second request",
    );
  });

  it("preserves a status webhook that arrives while the boundary reader awaits a page", async () => {
    const ctx = context();
    const mock = world({
      during: (operation) => {
        if (operation === "read-messages")
          expectActivity(ctx.store, 1, 5, { status: "pending", at: Date.now() / 1000 });
      },
    });
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("not available yet");
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
  });

  it("fits a complete five-page turn with labels, reply and assignment into the configured budget", async () => {
    const mock = world(
      {
        messages: [
          activity(1, "pending"),
          incoming(2),
          ...Array.from({ length: 79 }, (_, i) => ({ id: i + 3, message_type: 2 })),
        ],
      },
      { owner: ["cloud", 1], kind: ["startup", 1] },
    );
    const ctx = context(new MemoryStore(), KINDS);
    const budget = new Budget(45, ctx.fetch);
    await routeConversation(
      {
        ...ctx,
        fetch: budget.fetch,
        chatwoot: chatwootClient(ctx.settings.config.chatwoot.baseUrl, "user-token", budget.fetch),
      },
      1,
      5,
    );
    expect(mock.ticket.assignee).toMatchObject({ id: 6 });
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toHaveLength(1);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
  });

  it("rejects unknown Jev choices before any Chatwoot mutation", async () => {
    const mock = world({}, { owner: ["invented-owner", 1] });
    await expect(routeConversation(context(), 1, 5)).rejects.toThrow("no valid owner");
    expect(
      mock.requests.filter((request) => request.method === "POST" && request.url.hostname === "chatwoot.example.com"),
    ).toEqual([]);
  });

  it("waits for the resolution activity when a fresh action read observed a human end the turn", async () => {
    const mock = world({
      during: (operation) => {
        if (operation === "jev") {
          mock.ticket.status = "resolved";
          mock.ticket.updatedAt = Date.now() / 1000;
        }
      },
    });
    const ctx = context();
    await routeConversation(ctx, 1, 5);
    mock.ticket.status = "pending";
    delete mock.ticket.during;
    mock.ticket.messages?.push(incoming(2, "Reopened before activity"));
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("not available yet");
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(1);
  });

  it("remembers a resolved retry after a lost response until its delayed activity arrives", async () => {
    const mock = world(
      {
        lose: { toggle_status: 1 },
        messages: [incoming(1, "Old spam")],
        during: (operation) => {
          if (operation === "toggle_status") mock.ticket.messages?.pop(); // Activity job has not run yet.
        },
      },
      { owner: ["unclear", 1], kind: ["spam", 1] },
    );
    const ctx = context(new MemoryStore(), KINDS);
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("503");
    expect(mock.ticket.status).toBe("resolved");
    await routeConversation(ctx, 1, 5); // Retry confirms the turn ended despite the lost response.
    delete mock.ticket.during;
    mock.ticket.status = "pending";
    mock.ticket.messages?.push(incoming(2, "New request"));
    await expect(routeConversation(ctx, 1, 5)).rejects.toThrow("not available yet");
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(1);
    expect(mock.ticket.status).toBe("pending");
    mock.ticket.messages?.push(activity(3), incoming(4, "Follow-up after resolution activity"));
    mock.answers.kind = ["none", 1];
    await routeConversation(ctx, 1, 5);
    expect(JSON.parse(sent(mock.requests, "POST", JEV).at(-1)?.body ?? "{}").state.ticket).toBe(
      "Follow-up after resolution activity",
    );
    expect(mock.ticket.status).toBe("open");
  });

  it.each(["initial snapshot", "fresh action read"])(
    "uses the existing resolution boundary after a metadata-only update in an %s",
    async (stage) => {
      const at = Math.floor(Date.now() / 1000);
      const mock = world(
        { status: "resolved", updatedAt: at + 10, messages: [incoming(1, "Old spam"), activity(2)] },
        { owner: ["unclear", 1], kind: ["spam", 1] },
      );
      const ctx = context(new MemoryStore(), KINDS);
      if (stage === "fresh action read") {
        mock.ticket.status = "pending";
        mock.ticket.messages?.push(incoming(3, "Earlier turn"));
        mock.ticket.during = (operation) => {
          if (operation === "jev") {
            mock.ticket.status = "resolved";
            mock.ticket.messages?.push({ ...activity(4), created_at: at });
          }
        };
      }
      await routeConversation(ctx, 1, 5);
      delete mock.ticket.during;
      mock.ticket.status = "pending";
      mock.ticket.messages?.push(incoming(5, "New advertisement"));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await routeConversation(ctx, 1, 5);
          break;
        } catch {
          recordFailure(ctx.store, 1, 5); // The alarm's bounded retry policy.
        }
      }
      expect(mock.ticket.status).toBe("resolved");
      expect(JSON.parse(sent(mock.requests, "POST", JEV).at(-1)?.body ?? "{}").state.ticket).toBe("New advertisement");
    },
  );

  it("hands off an old attempt record without a confirmed message", async () => {
    const mock = world({}, { owner: ["cloud", 1], kind: ["startup", 1] });
    const ctx = context(new MemoryStore(), KINDS);
    ctx.store.set("reply:1:5", JSON.stringify({ inputId: 0, handled: 0, kind: "startup" }));
    await routeConversation(ctx, 1, 5);
    expect(sent(mock.requests, "POST", `${CW}/messages`)).toEqual([]);
    expect(mock.ticket.status).toBe("open");
  });
});
