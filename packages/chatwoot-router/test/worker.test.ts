import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { ROUTER_NAME } from "../src/router.ts";
import { eventTarget } from "../src/webhook.ts";
import { json, mockFetch, on } from "./helpers.ts";
import { activity, CW, incoming as customer, JEV, sent, world } from "./world.ts";

const stub = () => env.ROUTER.getByName(ROUTER_NAME);
const base = "chatwoot.example.com/api/v1/accounts/1/conversations";
const incoming = (conversationId: number, accountId = 1) => ({
  event: "message_created",
  id: 501,
  account: { id: accountId },
  conversation: { id: conversationId },
  sender: { type: "contact" },
  message_type: "incoming",
  private: false,
});

async function webhook(payload: unknown, secret = "secret-acme", age = 0): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
  const signature = [...signed].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return worker.fetch(
    new Request("https://router.example.com/chatwoot/agent-bot", {
      method: "POST",
      body,
      headers: { "x-chatwoot-timestamp": timestamp, "x-chatwoot-signature": `sha256=${signature}` },
    }),
    env,
    createExecutionContext(),
  );
}

async function drain(timeout = 5000): Promise<void> {
  await vi.waitFor(
    async () => {
      const due = await runInDurableObject(
        stub(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE not_before <= ?", Date.now())
            .one().count,
      );
      expect(due).toBe(0);
    },
    { timeout, interval: 20 },
  );
}

afterEach(async () => {
  await drain();
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM jobs; DELETE FROM cache");
    await state.storage.deleteAlarm();
  });
  vi.restoreAllMocks();
});

async function retryNow() {
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec("UPDATE jobs SET not_before = 0");
    await state.storage.setAlarm(Date.now());
  });
  await drain();
}

describe("bot webhook and durable recovery", () => {
  it("returns only a customer event's identity and ignores bot messages, private notes and unknown signed events", async () => {
    expect(eventTarget(incoming(5))).toEqual({ accountId: 1, conversationId: 5 });
    for (const payload of [
      { ...incoming(5), message_type: "outgoing" },
      { ...incoming(5), private: true },
      { ...incoming(5), sender: { type: "agent_bot" } },
      { ...incoming(5), event: "unknown" },
      { event: "conversation_created", account: { id: 1 }, id: 5 },
    ]) {
      expect(eventTarget(payload)).toBeUndefined();
      expect((await webhook(payload)).status).toBe(200);
    }
  });

  it("authenticates each account and rejects stale, mismatched or invalid signatures", async () => {
    expect((await webhook(incoming(5), "wrong")).status).toBe(401);
    expect((await webhook(incoming(5), "secret-acme", 1000)).status).toBe(401);
    expect((await webhook(incoming(5, 2))).status).toBe(403);
    expect(
      (
        await worker.fetch(
          new Request("https://router.example.com/chatwoot/webhook", { method: "POST" }),
          env,
          createExecutionContext(),
        )
      ).status,
    ).toBe(404);
  });

  it("reports readiness without exposing invalid configuration or credentials", async () => {
    const request = new Request("https://router.example.com/healthz");
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(await response.json()).toEqual({ ok: true });
    const failed = await worker.fetch(request, { ...env, CHATWOOT_AGENT_BOT_TOKENS: "{}" }, createExecutionContext());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false });
  });

  it("keeps equal conversation ids and credentials separate while another account backs off", async () => {
    const statuses = new Map([
      [1, "pending"],
      [2, "pending"],
    ]);
    let unavailable = true;
    const accountId = (request: { url: URL }) => Number(request.url.pathname.split("/")[4]);
    const mock = mockFetch(
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/[12]\/conversations\/5$/, (request) => {
        const id = accountId(request);
        if (id === 2 && unavailable) return json({}, { status: 503 });
        return json({ id: 5, inbox_id: 2, status: statuses.get(id) });
      }),
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/[12]\/inboxes\/2\/agent_bot$/, (request) => {
        const id = accountId(request);
        return json({ agent_bot: { id, account_id: id } });
      }),
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/[12]\/conversations\/5\/messages$/, () =>
        json({ payload: [] }),
      ),
      on("POST", /^chatwoot\.example\.com\/api\/v1\/accounts\/[12]\/conversations\/5\/toggle_status$/, (request) => {
        const id = accountId(request);
        expect(request.headers.get("api_access_token")).toBe(id === 1 ? "bot-token" : "other-bot-token");
        expect(JSON.parse(request.body)).toEqual({ status: "open" });
        statuses.set(id, "open");
        return json({});
      }),
    );
    expect((await webhook(incoming(5, 2), "secret-globex")).status).toBe(200);
    await drain();
    expect((await webhook(incoming(5))).status).toBe(200);
    await drain();
    expect([...statuses.values()]).toEqual(["open", "pending"]);
    unavailable = false;
    await retryNow();
    expect([...statuses.values()]).toEqual(["open", "open"]);
    expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("returns 2xx before processing, then hands off after three Jev failures and retries the handoff", async () => {
    const mock = world({ fail: { jev: 3, toggle_status: 1 } });
    expect((await webhook(incoming(5))).status).toBe(200);
    await drain();
    await webhook(incoming(5)); // Re-delivery must not reset the failure count/backoff.
    await retryNow();
    await retryNow();
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(3);
    await retryNow();
    expect(mock.ticket.status).toBe("pending");
    await retryNow();
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(3);
    expect(sent(mock.requests, "POST", `${CW}/toggle_status`)).toHaveLength(2);
  });

  it("handles activity that stays missing after three attempts without classifying old text", async () => {
    const mock = world();
    await webhook({
      event: "conversation_status_changed",
      id: 5,
      account: { id: 1 },
      updated_at: Date.now() / 1000,
      changed_attributes: [{ status: { previous_value: "open", current_value: "pending" } }],
    });
    await drain();
    await retryNow();
    await retryNow();
    await retryNow();
    expect(mock.ticket.status).toBe("open");
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
  });

  it("waits for a late handback activity, then classifies only its new input", async () => {
    const mock = world();
    await webhook({
      event: "conversation_status_changed",
      id: 5,
      account: { id: 1 },
      updated_at: Date.now() / 1000,
      changed_attributes: [{ status: { previous_value: "open", current_value: "pending" } }],
    });
    await drain();
    mock.ticket.messages?.push(activity(2, "pending"), customer(3, "New request"));
    await retryNow();
    expect(mock.ticket.status).toBe("open");
    expect(JSON.parse(sent(mock.requests, "POST", JEV)[0]?.body ?? "{}").state.ticket).toBe("New request");
  });

  it("retains an event arriving during Jev and re-reads changed inputs", async () => {
    const mock = world({
      during: (operation) => {
        if (operation !== "jev" || (mock.ticket.messages?.length ?? 0) > 1) return;
        mock.ticket.messages?.push(customer(2, "Second request"));
      },
    });
    await webhook(incoming(5));
    await drain();
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(2);
    expect(mock.ticket.status).toBe("open");
  });

  it("drops a deleted conversation but retries an upstream proxy 404", async () => {
    let proxy = true;
    const mock = mockFetch(
      on("GET", CW, () => (proxy ? new Response("not found", { status: 404 }) : json({}, { status: 404 }))),
    );
    await webhook(incoming(5));
    await drain();
    proxy = false;
    await retryNow();
    expect(mock.requests).toHaveLength(2);
    await runInDurableObject(stub(), (_instance, state) =>
      expect(state.storage.sql.exec("SELECT * FROM jobs").toArray()).toEqual([]),
    );
  });
});

function sweepWorld(failPage = false, disconnect = false) {
  const pending = new Set(Array.from({ length: 50 }, (_, index) => index + 11));
  const pages: number[] = [];
  const mock = mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/1/inboxes", () => json({ payload: [{ id: 2 }, { id: 3 }] })),
    on("GET", "chatwoot.example.com/api/v1/accounts/2/inboxes", () => json({ payload: [] })),
    on("GET", "chatwoot.example.com/api/v1/accounts/1/inboxes/2/agent_bot", () =>
      json({ agent_bot: disconnect ? null : { id: 1, account_id: 1 } }),
    ),
    on("GET", "chatwoot.example.com/api/v1/accounts/1/inboxes/3/agent_bot", () => json({ agent_bot: null })),
    on("GET", "chatwoot.example.com/api/v1/accounts/2/conversations", () => json({ data: { payload: [] } })),
    on("GET", base, (request) => {
      expect(request.url.searchParams.get("status")).toBe("pending");
      const page = Number(request.url.searchParams.get("page"));
      pages.push(page);
      if (page === 2 && failPage) {
        failPage = false;
        return json({}, { status: 503 });
      }
      return json({
        data: {
          payload: [...pending]
            .slice((page - 1) * 25, page * 25)
            .map((id) => ({ id, inbox_id: 2, status: "pending", last_activity_at: 1 })),
        },
      });
    }),
    on("GET", new RegExp(`^${RegExp.escape(base)}/\\d+$`), (request) =>
      json({
        id: Number(request.url.pathname.split("/").at(-1)),
        inbox_id: 2,
        status: "pending",
        meta: { assignee_type: "AgentBot", assignee: { id: 1 } },
      }),
    ),
    on("GET", new RegExp(`^${RegExp.escape(base)}/\\d+/messages$`), () => json({ payload: [customer(1)] })),
    on("POST", new RegExp(`^${RegExp.escape(base)}/\\d+/labels$`), () => json({})),
    on("POST", new RegExp(`^${RegExp.escape(base)}/\\d+/toggle_status$`), (request) => {
      pending.delete(Number(request.url.pathname.split("/").at(-2)));
      return json({});
    }),
    on("POST", JEV, () =>
      json({
        answers: {
          owner: { choice: "unclear", confidence: 1 },
          kind: { choice: "spam", confidence: 1 },
          request: { choice: "request", confidence: 1 },
        },
      }),
    ),
  );
  return { ...mock, pending, pages };
}

describe("pending sweep", () => {
  it("continues across alarm budgets and covers page shifts in the next full pass, including old tickets", async () => {
    const mock = sweepWorld();
    const execution = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, execution);
    await waitOnExecutionContext(execution);
    await drain(15000);
    expect(mock.pending.size).toBe(25);
    expect(mock.pages).toEqual([1, 2]);
    await stub().requestSweep();
    await drain(15000);
    expect(mock.pending.size).toBe(0);
    expect(mock.pages).toEqual([1, 2, 1, 2]);
    expect(sent(mock.requests, "POST", JEV)).toHaveLength(50);
  }, 30000);

  it("retries the same failed page without delaying already queued routing", async () => {
    const mock = sweepWorld(true);
    await stub().requestSweep();
    await drain(15000);
    expect(mock.pending.size).toBe(25);
    await retryNow();
    expect(mock.pages).toEqual([1, 2, 2]);
    await stub().requestSweep();
    await drain(15000);
    expect(mock.pending.size).toBe(0);
  }, 30000);

  it("does not route disconnected inboxes even when their pending conversations are listed", async () => {
    const mock = sweepWorld(false, true);
    await stub().requestSweep();
    await drain(15000);
    expect(mock.pending.size).toBe(50);
    expect(sent(mock.requests, "POST", JEV)).toEqual([]);
  }, 20000);
});
