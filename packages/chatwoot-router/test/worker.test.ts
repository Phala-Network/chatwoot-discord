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
  const answers = { owner: { choice: "cloud", confidence: 1 }, kind: { choice: "none", confidence: 1 } };
  const failures = { account2: false };
  return {
    attributes,
    messages,
    state,
    answers,
    failures,
    ...mockFetch(
      on("GET", base, (request) =>
        json({
          data: {
            payload:
              Number(request.url.searchParams.get("page")) === 1 &&
              (request.url.searchParams.get("status") === "all" || (state.status ?? "open") === "open")
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
      on("GET", "chatwoot.example.com/api/v1/accounts/2/conversations", () =>
        failures.account2 ? json({}, { status: 503 }) : json({ data: { payload: [] } }),
      ),
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
      on("POST", new RegExp(`${base}/\\d+/labels$`), () => json({})),
      on("POST", new RegExp(`${base}/\\d+/toggle_status$`), (request) => {
        state.status = JSON.parse(request.body).status;
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
      on("POST", "api.typesafe.ai/v1/systemone", () => json({ answers })),
    ),
  };
}

function sweepingWorld(options: { failSecondPage?: boolean; externalClose?: boolean; ageSeconds?: number } = {}) {
  const ids = Array.from({ length: 50 }, (_, index) => index + 11);
  const open = new Set(ids);
  const activity = new Map(ids.map((id) => [id, Date.now() / 1000 - (options.ageSeconds ?? 0)]));
  const close = (id: number) => {
    open.delete(id);
    activity.set(id, Date.now() / 1000);
  };
  const pages: number[] = [];
  const attributes = new Map<number, object>();
  let failed = false;
  let closedExternally = false;
  const mock = mockFetch(
    on("GET", base, (request) => {
      const page = Number(request.url.searchParams.get("page"));
      if (page === 2 && options.failSecondPage && !failed) {
        failed = true;
        return json({}, { status: 503 });
      }
      const visible = ids.filter((id) => request.url.searchParams.get("status") === "all" || open.has(id));
      visible.sort((first, second) => (activity.get(second) ?? 0) - (activity.get(first) ?? 0) || first - second);
      const listed = visible.slice((page - 1) * 25, page * 25);
      pages.push(listed.length);
      const response = json({
        data: {
          payload: listed.map((id) => ({
            id,
            status: open.has(id) ? "open" : "resolved",
            last_activity_at: activity.get(id),
            custom_attributes: attributes.get(id) ?? {},
          })),
        },
      });
      if (options.externalClose && page === 1 && !closedExternally) {
        closedExternally = true;
        for (const id of listed) close(id);
      }
      return response;
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
      close(Number(request.url.pathname.split("/").at(-2)));
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
  return { ...mock, open, pages };
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

  it("repairs an assigned decision during a sweep without processing new messages", async () => {
    const mock = world();
    await webhook(incoming(11));
    await drain();
    expect(mock.attributes).toMatchObject({ routing_seen: 501 });
    expect(mock.state.assignee).toEqual({ id: 6 });
    delete mock.attributes.routing_seen;
    mock.attributes.discord_thread = "https://discord.com/channels/100000000000000001/100000000000000002";
    mock.messages.push({ id: 601, message_type: 0, content: "Another question." });
    const before = mock.requests.length;
    await stub().requestSweep();
    await drain();
    expect(mock.attributes).toMatchObject({
      routing_seen: 501,
      discord_thread: "https://discord.com/channels/100000000000000001/100000000000000002",
    });
    expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toHaveLength(1);
    expect(mock.requests.slice(before).some((request) => request.url.pathname.endsWith("/messages"))).toBe(false);
  });

  it("interleaves routing with all-status sweep pages without skipping tickets", async () => {
    const sweep = sweepingWorld();
    await stub().requestSweep();
    await drain(15000);
    expect(sweep.pages).toEqual([25, 25, 0]);
    expect(sweep.open.size).toBe(0);
    const firstClose = sweep.requests.findIndex((request) => request.url.pathname.endsWith("/toggle_status"));
    const secondPage = sweep.requests.findIndex((request) => request.url.searchParams.get("page") === "2");
    expect(firstClose).toBeGreaterThan(-1);
    expect(firstClose).toBeLessThan(secondPage);
  }, 20000);

  it("does not skip old tickets when the first page closes externally", async () => {
    const sweep = sweepingWorld({ externalClose: true, ageSeconds: 4000 });
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO cache (key, value) VALUES (?, ?)",
        "sweep:1:last",
        String(Date.now() - 5000 * 1000),
      );
    });
    await stub().requestSweep();
    await drain(15000);
    const firstPass = [...sweep.pages];
    await stub().requestSweep();
    await drain(15000);
    expect(sweep.open.size).toBe(0);
    expect(firstPass).toEqual([25, 25, 0]);
  }, 20000);

  it("resumes a failed sweep page without holding its routes or advancing the pass watermark", async () => {
    const sweep = sweepingWorld({ failSecondPage: true });
    await stub().requestSweep();
    await vi.waitFor(
      async () => {
        await runInDurableObject(stub(), (_instance, state) => {
          expect(
            state.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM jobs WHERE key = ?", "sweep:1").one()
              .attempts,
          ).toBe(1);
        });
      },
      { timeout: 10000 },
    );
    const pass = await runInDurableObject(stub(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT value FROM cache WHERE key = ?", "sweep:1:last").toArray()).toEqual([]);
      return JSON.parse(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM cache WHERE key = ?", "sweep:1:pass").one().value,
      );
    });
    expect(pass.page).toBe(2);
    const remainingDuringBackoff = sweep.open.size;
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0 WHERE key = ?", "sweep:1");
      await state.storage.setAlarm(Date.now());
    });
    await drain(15000);
    expect(sweep.pages).toEqual([25, 25, 0]);
    expect(sweep.open.size).toBe(0);
    expect(remainingDuringBackoff).toBe(25);
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM cache WHERE key = ?", "sweep:1:last").one().value,
      ).toBe(String(pass.startedAt));
      expect(state.storage.sql.exec("SELECT value FROM cache WHERE key = ?", "sweep:1:pass").toArray()).toEqual([]);
    });
  }, 20000);

  it("runs account 1's due route while account 2's sweep is backing off", async () => {
    const mock = world(0, { status: "resolved" });
    mock.failures.account2 = true;
    await stub().requestSweep();
    await drain();
    await runInDurableObject(stub(), (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ attempts: number; not_before: number }>(
            "SELECT attempts, not_before FROM jobs WHERE key = ?",
            "sweep:2",
          )
          .one(),
      ).toMatchObject({ attempts: 1 });
    });
    try {
      await webhook(incoming(11));
      await drain(1000);
      expect(mock.attributes.routing_seen).toBe(501);
      await runInDurableObject(stub(), (_instance, state) => {
        expect(
          state.storage.sql.exec<{ not_before: number }>("SELECT not_before FROM jobs WHERE key = ?", "sweep:2").one()
            .not_before,
        ).toBeGreaterThan(Date.now());
      });
    } finally {
      await runInDurableObject(stub(), async (_instance, state) => {
        state.storage.sql.exec("DELETE FROM jobs WHERE key = ?", "sweep:2");
        await state.storage.setAlarm(Date.now());
      });
      await drain();
    }
  });

  it.each(["resolved", "snoozed"])(
    "repairs lost attributes on a %s ticket through the sweep without replaying its decision",
    async (status) => {
      const mock = world();
      const kind = status === "resolved" ? "spam" : "newsletter";
      mock.answers.owner.choice = "unclear";
      mock.answers.kind.choice = kind;
      await webhook(incoming(11));
      await drain();
      expect(mock.state.status).toBe(status);
      expect(mock.attributes).toMatchObject({ routing_seen: 501, routing_handled: 501, routing_kind: kind });
      expect(mock.requests.filter((request) => request.url.pathname.endsWith("/custom_attributes"))).toHaveLength(1);
      delete mock.attributes.routing_seen;
      delete mock.attributes.routing_handled;
      delete mock.attributes.routing_kind;
      mock.attributes.discord_thread = "https://discord.com/channels/100000000000000001/100000000000000002";
      const before = mock.requests.length;
      await stub().requestSweep();
      await drain();
      expect(mock.attributes).toMatchObject({
        routing_seen: 501,
        routing_handled: 501,
        routing_kind: kind,
        discord_thread: "https://discord.com/channels/100000000000000001/100000000000000002",
      });
      expect(
        mock.requests
          .slice(before)
          .filter((request) => request.url.pathname.includes("/conversations/"))
          .map((request) => `${request.method} ${request.url.pathname}`),
      ).toEqual([
        "GET /api/v1/accounts/1/conversations/11",
        "POST /api/v1/accounts/1/conversations/11/custom_attributes",
      ]);
      expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toHaveLength(1);
      const repaired = mock.requests.length;
      await stub().requestSweep();
      await drain();
      expect(mock.requests.slice(repaired).every((request) => request.url.pathname.endsWith("/conversations"))).toBe(
        true,
      );
      Object.assign(mock.attributes, { routing_seen: 701, routing_handled: 401, routing_kind: "other" });
      await stub().requestSweep();
      await drain();
      expect(mock.attributes).toMatchObject({ routing_seen: 701, routing_handled: 501, routing_kind: kind });
      delete mock.attributes.routing_seen;
      await stub().requestSweep();
      await drain();
      expect(mock.attributes.routing_seen).toBe(701);
      expect(mock.requests.filter((request) => request.url.hostname === "api.typesafe.ai")).toHaveLength(1);
    },
  );

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
        expect(request.url.searchParams.get("status")).toBe("all");
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
        expect(request.url.searchParams.get("status")).toBe("all");
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
      "/api/v1/accounts/1/conversations/14",
      "/api/v1/accounts/1/conversations/9",
      "/api/v1/accounts/2/conversations/2",
      "/api/v1/accounts/2/conversations/9",
    ]);
  });
});
