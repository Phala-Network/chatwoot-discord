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

async function drain(): Promise<void> {
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
    { timeout: 5000, interval: 20 },
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

function world(failAttributes = 0) {
  const attributes: Record<string, unknown> = { unrelated: "kept" };
  return {
    attributes,
    ...mockFetch(
      on("GET", new RegExp(`${base}/\\d+$`), (request) =>
        json({
          id: Number(request.url.pathname.split("/").at(-1)),
          status: "open",
          meta: { assignee: null },
          custom_attributes: attributes,
          labels: [],
        }),
      ),
      on("GET", new RegExp(`${base}/\\d+/messages$`), (request) =>
        json({
          payload: [{ id: 501, message_type: 0, content: "Where is my invoice?" }].filter(
            (message) => message.id > Number(request.url.searchParams.get("after") ?? 0),
          ),
        }),
      ),
      on("POST", new RegExp(`${base}/\\d+/assignments$`), () => json({})),
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
        json({ answers: { owner: { choice: "cloud", confidence: 1 } } }),
      ),
    ),
  };
}

describe("router worker", () => {
  it("reports configuration readiness without exposing errors", async () => {
    const request = () => new Request("https://router.example.com/healthz");
    expect((await worker.fetch(request(), env, createExecutionContext())).status).toBe(200);
    const invalid = await worker.fetch(request(), { ...env, CONFIG: {} }, createExecutionContext());
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toEqual({ ok: false });
  });

  it("authenticates per account, rejects stale signatures, and ignores non-customer messages and cutover history", async () => {
    const mock = mockFetch();
    expect((await webhook(incoming(11), "wrong")).status).toBe(401);
    expect((await webhook(incoming(11), "secret-acme", 301)).status).toBe(401);
    expect((await webhook(incoming(11), "secret-globex")).status).toBe(403);
    expect((await webhook({ ...incoming(11), message_type: "outgoing" })).status).toBe(200);
    expect((await webhook({ ...incoming(11), private: true })).status).toBe(200);
    expect((await webhook({ ...incoming(11), sender: { type: "user" } })).status).toBe(200);
    expect((await webhook(incoming(10))).status).toBe(200);
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

  it("queues the same display id only for the account past its cutover", async () => {
    const path = "chatwoot.example.com/api/v1/accounts/2/conversations/10";
    const mock = mockFetch(
      on("GET", path, () => json({ id: 10, status: "open", meta: { assignee: null } })),
      on("GET", `${path}/messages`, () => json({ payload: [] })),
    );
    expect((await webhook(incoming(10))).status).toBe(200);
    expect((await webhook(incoming(2, 2), "secret-globex")).status).toBe(200);
    expect((await webhook(incoming(10, 2), "secret-globex")).status).toBe(200);
    await drain();
    expect(mock.requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/accounts/2/conversations/10",
      "/api/v1/accounts/2/conversations/10/messages",
    ]);
  });

  it("routes relevant conversation events and sweeps open, unassigned tickets in its activity window", async () => {
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
      on("GET", `${base}/14`, () => json({ id: 14, status: "open", meta: { assignee: null } })),
      on("GET", `${base}/14/messages`, () => json({ payload: [] })),
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
      on("GET", "chatwoot.example.com/api/v1/accounts/2/conversations/9", () =>
        json({ id: 9, status: "open", meta: { assignee: null } }),
      ),
      on("GET", "chatwoot.example.com/api/v1/accounts/2/conversations/9/messages", () => json({ payload: [] })),
    );
    const context = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, context);
    await waitOnExecutionContext(context);
    await drain();
    expect(
      requests.requests
        .filter((request) => /\/conversations\/\d+$/.test(request.url.pathname))
        .map((request) => request.url.pathname)
        .sort(),
    ).toEqual(["/api/v1/accounts/1/conversations/14", "/api/v1/accounts/2/conversations/9"]);
  });
});
