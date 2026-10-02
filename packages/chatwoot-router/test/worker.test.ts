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
import { json, mockFetch, on } from "./helpers.ts";

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
    new Request("https://router.example.com/chatwoot/webhook", {
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

function world(failAttributes = 0, state: { status?: string; assignee?: { id: number } } = {}) {
  const attributes: Record<string, unknown> = { unrelated: "kept" };
  const messages = [{ id: 501, message_type: 0, content: "Where is my invoice?" }];
  return {
    attributes,
    messages,
    state,
    ...mockFetch(
      on("GET", base, (request) =>
        json({
          data: {
            payload:
              Number(request.url.searchParams.get("page")) === 1
                ? [
                    {
                      id: 11,
                      status: state.status ?? "open",
                      meta: { assignee: state.assignee ?? null },
                      last_activity_at: Date.now() / 1000,
                      custom_attributes: attributes,
                    },
                  ]
                : [],
          },
        }),
      ),
      on("GET", "chatwoot.example.com/api/v1/accounts/2/conversations", () => json({ data: { payload: [] } })),
      on("GET", new RegExp(`${base}/\\d+$`), (request) =>
        json({
          id: Number(request.url.pathname.split("/").at(-1)),
          status: state.status ?? "open",
          meta: { assignee: state.assignee ?? null },
          custom_attributes: attributes,
          labels: [],
        }),
      ),
      on("GET", new RegExp(`${base}/\\d+/messages$`), (request) =>
        json({
          payload: messages.filter((message) => message.id > Number(request.url.searchParams.get("after") ?? 0)),
        }),
      ),
      on("POST", new RegExp(`${base}/\\d+/assignments$`), () => {
        state.assignee = { id: 6 };
        return json({});
      }),
      on("POST", new RegExp(`${base}/\\d+/custom_attributes$`), (request) => {
        if (failAttributes > 0) {
          failAttributes -= 1;
          return json({}, { status: 503 });
        }
        const body = JSON.parse(request.body);
        expect(body.merge).toBe(true);
        Object.assign(attributes, body.custom_attributes);
        return json({});
      }),
      on("POST", "api.typesafe.ai/v1/systemone", () =>
        json({ answers: { owner: { choice: "cloud", confidence: 1 }, kind: { choice: "none", confidence: 1 } } }),
      ),
    ),
  };
}

function sweepingWorld(failSecondPage = false) {
  const open = new Set(Array.from({ length: 50 }, (_, index) => index + 11));
  const pages: number[] = [];
  const attributes = new Map<number, object>();
  let failed = false;
  mockFetch(
    on("GET", base, (request) => {
      const page = Number(request.url.searchParams.get("page"));
      if (page === 2 && failSecondPage && !failed) {
        failed = true;
        return json({}, { status: 503 });
      }
      const ids = [...open].slice((page - 1) * 25, page * 25);
      pages.push(ids.length);
      return json({
        data: { payload: ids.map((id) => ({ id, status: "open", last_activity_at: Date.now() / 1000 })) },
      });
    }),
    on("GET", "chatwoot.example.com/api/v1/accounts/2/conversations", () => json({ data: { payload: [] } })),
    on("GET", new RegExp(`${base}/\\d+$`), (request) => {
      const id = Number(request.url.pathname.split("/").at(-1));
      return json({
        id,
        status: open.has(id) ? "open" : "resolved",
        labels: [],
        meta: { assignee: null },
        custom_attributes: attributes.get(id) ?? {},
      });
    }),
    on("GET", new RegExp(`${base}/\\d+/messages$`), (request) =>
      json({
        payload:
          Number(request.url.searchParams.get("after") ?? 0) < 1
            ? [{ id: 1, message_type: 0, content: "Unsolicited advertising." }]
            : [],
      }),
    ),
    on("POST", new RegExp(`${base}/\\d+/labels$`), () => json({})),
    on("POST", new RegExp(`${base}/\\d+/toggle_status$`), (request) => {
      open.delete(Number(request.url.pathname.split("/").at(-2)));
      return json({});
    }),
    on("POST", new RegExp(`${base}/\\d+/custom_attributes$`), (request) => {
      attributes.set(Number(request.url.pathname.split("/").at(-2)), JSON.parse(request.body).custom_attributes);
      return json({});
    }),
    on("POST", "api.typesafe.ai/v1/systemone", () =>
      json({ answers: { owner: { choice: "unclear", confidence: 1 }, kind: { choice: "spam", confidence: 1 } } }),
    ),
  );
  return { open, pages };
}

describe("router worker", () => {
  it.each(["assigned", "resolved", "snoozed"])(
    "queues and acknowledges contact messages on %s tickets",
    async (reason) => {
      const mock = world(0, reason === "assigned" ? { assignee: { id: 6 } } : { status: reason });
      await webhook(incoming(11));
      await drain();
      expect(mock.attributes).toMatchObject({ routing_seen: 501 });
      await webhook({ ...incoming(11), id: 601 });
      await drain();
      await webhook(incoming(11));
      await drain();
      expect(mock.attributes).toMatchObject({ routing_seen: 601 });
      expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toEqual([]);
    },
  );

  it("repairs an assigned done decision and acknowledges a missed customer webhook during a sweep", async () => {
    const mock = world();
    await webhook(incoming(11));
    await drain();
    expect(mock.attributes).toMatchObject({ routing_seen: 501 });
    expect(mock.state.assignee).toEqual({ id: 6 });
    delete mock.attributes.routing_seen;
    mock.attributes.discord_thread = "https://discord.com/channels/100000000000000001/100000000000000002";
    mock.messages.push({ id: 601, message_type: 0, content: "Another question." });
    await stub().requestSweep();
    await drain();
    expect(mock.attributes).toMatchObject({
      routing_seen: 601,
      discord_thread: "https://discord.com/channels/100000000000000001/100000000000000002",
    });
    expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toHaveLength(1);
  });

  it("finishes paging all 50 open tickets before routing closes the first 25", async () => {
    const sweep = sweepingWorld();
    await stub().requestSweep();
    await drain(15000);
    expect(sweep.pages).toEqual([25, 25, 0]);
    expect(sweep.open.size).toBe(0);
  }, 20000);

  it("keeps sweep route jobs blocked across a failed page and its retry", async () => {
    const sweep = sweepingWorld(true);
    await stub().requestSweep();
    await vi.waitFor(async () => {
      const alarm = await runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());
      expect(alarm).toBeGreaterThan(Date.now());
    });
    expect(sweep.open.size).toBe(50);
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0 WHERE key = ?", "sweep:1");
      await state.storage.setAlarm(Date.now());
    });
    await drain(15000);
    expect(sweep.pages).toEqual([25, 25, 0]);
    expect(sweep.open.size).toBe(0);
  }, 20000);

  it("acknowledges pre-cutover contact webhooks using the webhook message id", async () => {
    const mock = world();
    expect((await webhook(incoming(10))).status).toBe(200);
    await drain();
    expect(mock.attributes).toMatchObject({ routing_seen: 501 });
    expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toEqual([]);
  });

  it("repairs a completed decision's lost attributes on a conversation webhook", async () => {
    const mock = world();
    await webhook(incoming(11));
    await drain();
    delete mock.attributes.routing_seen;
    mock.attributes.discord_thread = "https://discord.com/channels/100000000000000001/100000000000000002";
    await webhook({ event: "conversation_updated", id: 11, account: { id: 1 } });
    await drain();
    expect(mock.attributes).toMatchObject({
      routing_seen: 501,
      discord_thread: "https://discord.com/channels/100000000000000001/100000000000000002",
    });
    expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toHaveLength(1);
  });

  it("reports configuration readiness without exposing errors", async () => {
    const request = () => new Request("https://router.example.com/healthz");
    expect((await worker.fetch(request(), env, createExecutionContext())).status).toBe(200);
    const invalid = await worker.fetch(request(), { ...env, CONFIG: {} }, createExecutionContext());
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toEqual({ ok: false });
  });

  it("authenticates per account, rejects stale signatures, and ignores non-customer messages", async () => {
    const mock = mockFetch();
    expect((await webhook(incoming(11), "wrong")).status).toBe(401);
    expect((await webhook(incoming(11), "secret-acme", 301)).status).toBe(401);
    expect((await webhook(incoming(11), "secret-globex")).status).toBe(403);
    expect((await webhook({ ...incoming(11), message_type: "outgoing" })).status).toBe(200);
    expect((await webhook({ ...incoming(11), private: true })).status).toBe(200);
    expect((await webhook({ ...incoming(11), sender: { type: "user" } })).status).toBe(200);
    await drain();
    expect(mock.requests).toEqual([]);
  });

  it("durably retries a failed attribute write without asking Jev again, including repeated webhooks", async () => {
    const mock = world(1);
    expect((await webhook(incoming(11))).status).toBe(200);
    await drain();
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(state.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM jobs").one().attempts).toBe(1);
      state.storage.sql.exec("UPDATE jobs SET not_before = 0");
      await state.storage.setAlarm(Date.now());
    });
    await drain();
    expect(mock.attributes).toEqual({ unrelated: "kept", routing_seen: 501 });
    await webhook(incoming(11));
    await drain();
    expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toHaveLength(1);
  });

  it("acknowledges the same display id independently for both accounts at cutover", async () => {
    const attributes = new Map<string, object>();
    const mock = mockFetch(
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/[12]\/conversations\/10$/, () =>
        json({ id: 10, status: "open", meta: { assignee: null } }),
      ),
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/[12]\/conversations\/10\/messages$/, () =>
        json({ payload: [] }),
      ),
      on(
        "POST",
        /^chatwoot\.example\.com\/api\/v1\/accounts\/[12]\/conversations\/10\/custom_attributes$/,
        (request) => {
          attributes.set(request.url.pathname, JSON.parse(request.body).custom_attributes);
          return json({});
        },
      ),
    );
    expect((await webhook(incoming(10))).status).toBe(200);
    expect((await webhook(incoming(10, 2), "secret-globex")).status).toBe(200);
    await drain();
    expect([...attributes]).toEqual([
      ["/api/v1/accounts/1/conversations/10/custom_attributes", { routing_seen: 501 }],
      ["/api/v1/accounts/2/conversations/10/custom_attributes", { routing_seen: 501 }],
    ]);
    expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toEqual([]);
  });

  it("routes relevant events and checks every open ticket in the sweep's activity window", async () => {
    const mock = world();
    await webhook({ event: "conversation_status_changed", id: 12, account: { id: 1 } });
    await drain();
    mock.spy.mockRestore();
    const requests = mockFetch(
      on("GET", base, (request) => {
        expect(request.url.searchParams.get("status")).toBe("open");
        return json({
          data: {
            payload: [
              { id: 9, status: "open", last_activity_at: Date.now() / 1000 },
              { id: 13, status: "open", meta: { assignee: { id: 6 } }, last_activity_at: Date.now() / 1000 },
              { id: 14, status: "open", last_activity_at: Date.now() / 1000 },
              { id: 15, status: "open", last_activity_at: Date.now() / 1000 - 7200 },
            ],
          },
        });
      }),
      on("GET", new RegExp(`${base}/(9|13|14)$`), (request) =>
        json({
          id: Number(request.url.pathname.split("/").at(-1)),
          status: "open",
          meta: { assignee: request.url.pathname.endsWith("/13") ? { id: 6 } : null },
        }),
      ),
      on("GET", new RegExp(`${base}/(9|13|14)/messages$`), () => json({ payload: [] })),
      on("GET", "chatwoot.example.com/api/v1/accounts/2/conversations", (request) => {
        expect(request.url.searchParams.get("status")).toBe("open");
        return json({
          data: {
            payload: [
              { id: 9, status: "open", last_activity_at: Date.now() / 1000 },
              { id: 2, status: "open", last_activity_at: Date.now() / 1000 },
              { id: 1, status: "open", last_activity_at: Date.now() / 1000 - 7200 },
            ],
          },
        });
      }),
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/2\/conversations\/(2|9)$/, () =>
        json({ id: 9, status: "open", meta: { assignee: null } }),
      ),
      on("GET", /^chatwoot\.example\.com\/api\/v1\/accounts\/2\/conversations\/(2|9)\/messages$/, () =>
        json({ payload: [] }),
      ),
    );
    const context = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, context);
    await waitOnExecutionContext(context);
    await drain();
    expect(
      [
        ...new Set(
          requests.requests
            .filter((request) => /\/conversations\/\d+$/.test(request.url.pathname))
            .map((request) => request.url.pathname),
        ),
      ].sort(),
    ).toEqual([
      "/api/v1/accounts/1/conversations/13",
      "/api/v1/accounts/1/conversations/14",
      "/api/v1/accounts/1/conversations/9",
      "/api/v1/accounts/2/conversations/2",
      "/api/v1/accounts/2/conversations/9",
    ]);
  });
});
