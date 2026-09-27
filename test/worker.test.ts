// End to end through the Worker and the Hub Durable Object (alarms included), with Chatwoot and
// Discord faked at the fetch boundary.

import {
  createExecutionContext,
  createScheduledController,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { ALICE, json, mockFetch, on, type Recorded, type Route } from "./helpers.js";

const FORUM = "100000000000000055";
const GUILD = "100000000000000044";
const encoder = new TextEncoder();

// Thread ids stay unique across tests: the Durable Object's storage persists within this file.
let threadCounter = 10000;
function nextThreadId(): string {
  threadCounter += 1;
  return `1000000000000${threadCounter}`;
}

interface FakeConversation {
  id: number;
  status: string;
  custom_attributes: Record<string, unknown>;
  messages: Array<{
    id: number;
    content: string;
    message_type: number;
    private?: boolean;
    sender?: Record<string, unknown>;
  }>;
}

/** A tiny Chatwoot + Discord: enough state to exercise the relay end to end. */
class World {
  conversations = new Map<number, FakeConversation>();
  threads = new Map<string, string>(); // thread id -> parent forum
  failReplies = 0;
  readonly mock: ReturnType<typeof mockFetch>;

  constructor(extra: Route[] = []) {
    this.mock = mockFetch(...extra, ...this.routes());
  }

  conversation(id: number, messages: FakeConversation["messages"], custom_attributes: Record<string, unknown> = {}) {
    this.conversations.set(id, { id, status: "open", custom_attributes, messages });
  }

  get requests(): Recorded[] {
    return this.mock.requests;
  }

  webhookPosts(): Array<{ thread: string | null; body: Record<string, unknown> }> {
    return this.requests
      .filter((request) => request.method === "POST" && /^\/api\/v10\/webhooks\/1\/tok$/.test(request.url.pathname))
      .map((request) => ({ thread: request.url.searchParams.get("thread_id"), body: JSON.parse(request.body) }));
  }

  private conversationJson(conversation: FakeConversation) {
    return {
      id: conversation.id,
      status: conversation.status,
      inbox_id: 2,
      custom_attributes: conversation.custom_attributes,
      meta: { sender: { name: "Jane Doe", email: "jane@example.com" }, channel: "Channel::WebWidget" },
      messages: conversation.messages.slice(-1).map(({ id }) => ({ id })),
    };
  }

  private routes(): Route[] {
    const cw = "chatwoot.example.com/api/v1/accounts/3";
    return [
      on("GET", new RegExp(`^${cw}/conversations/(\\d+)$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-1)));
        return conversation ? json(this.conversationJson(conversation)) : json({}, { status: 404 });
      }),
      on("GET", new RegExp(`^${cw}/conversations/(\\d+)/messages$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-2)));
        const after = request.url.searchParams.get("after");
        const messages = (conversation?.messages ?? []).filter(
          (message) => after === null || message.id > Number(after),
        );
        return json({ meta: {}, payload: after === null ? messages.slice(-20) : messages.slice(0, 100) });
      }),
      on("POST", new RegExp(`^${cw}/conversations/(\\d+)/custom_attributes$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-2)));
        const body = JSON.parse(request.body);
        // Chatwoot's merge semantics (ConversationCustomAttributesConcern at v4.18.0).
        if (conversation) {
          conversation.custom_attributes = body.merge
            ? { ...conversation.custom_attributes, ...body.custom_attributes }
            : body.custom_attributes;
        }
        return json({});
      }),
      on("GET", "chatwoot.example.com/api/v1/accounts/1/conversations", () =>
        json({ data: { meta: {}, payload: [] } }),
      ),
      on("GET", `${cw}/inboxes/2`, () => json({ id: 2, name: "Acme — Product App" })),
      on("GET", `${cw}/conversations`, () =>
        json({ data: { meta: {}, payload: [...this.conversations.values()].map((c) => this.conversationJson(c)) } }),
      ),
      on("GET", `discord.com/api/v10/channels/${FORUM}/webhooks`, () =>
        json([{ id: "1", token: "tok", type: 1, name: "Chatwoot" }]),
      ),
      on("GET", `discord.com/api/v10/channels/${FORUM}`, () =>
        json({
          id: FORUM,
          type: 15,
          guild_id: GUILD,
          available_tags: [
            { id: "t-acme", name: "Acme" },
            { id: "t-open", name: "open" },
          ],
        }),
      ),
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+$/, (request) => {
        const id = request.url.pathname.split("/").at(-1) ?? "";
        const parent = this.threads.get(id);
        return parent
          ? json({ id, type: 11, parent_id: parent })
          : json({ message: "Unknown Channel", code: 10003 }, { status: 404 });
      }),
      on("PATCH", /^discord\.com\/api\/v10\/channels\/\d+$/, () => json({})),
      on("POST", "discord.com/api/v10/webhooks/1/tok", (request) => {
        const thread = request.url.searchParams.get("thread_id");
        if (thread) {
          if (this.failReplies > 0) {
            this.failReplies -= 1;
            return json({ message: "Internal Server Error" }, { status: 500 });
          }
          return json({ id: "m", channel_id: thread });
        }
        const id = nextThreadId();
        this.threads.set(id, FORUM);
        return json({ id: "m", channel_id: id });
      }),
      on("PATCH", /^discord\.com\/api\/v10\/webhooks\/100000000000000001\/[^/]+\/messages\/(@|%40)original$/, () =>
        json({}),
      ),
    ];
  }
}

function hub() {
  return env.HUB.getByName("global");
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request<unknown, IncomingRequestCfProperties>(request), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function chatwootWebhook(
  payload: unknown,
  { secret = "secret-acme", delivery = crypto.randomUUID(), timestamp = Math.floor(Date.now() / 1000) } = {},
) {
  const body = JSON.stringify(payload);
  const ts = String(timestamp);
  return call(
    new Request("https://relay.example.com/chatwoot/webhook", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-chatwoot-timestamp": ts,
        "x-chatwoot-signature": `sha256=${await hmac(secret, `${ts}.${body}`)}`,
        "x-chatwoot-delivery": delivery,
      },
    }),
  );
}

async function discordInteraction(payload: unknown, tamper = false) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.TEST_DISCORD_PRIVATE_JWK),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, encoder.encode(timestamp + body)));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return call(
    new Request("https://relay.example.com/discord/interactions", {
      method: "POST",
      body: tamper ? body.replace("1", "2") : body,
      headers: { "content-type": "application/json", "x-signature-ed25519": hex, "x-signature-timestamp": timestamp },
    }),
  );
}

function dueJobs(): Promise<number> {
  return runInDurableObject(hub(), (_instance, state) => {
    const row = state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE not_before <= ?", Date.now())
      .one();
    return row.n;
  });
}

/**
 * Runs alarms until no job is due. Alarms set for "now" may also fire on their own in the
 * background, so this waits for the queue rather than counting alarm runs.
 */
async function drain(): Promise<void> {
  await vi.waitFor(
    async () => {
      await runDurableObjectAlarm(hub());
      if ((await dueJobs()) > 0) throw new Error("jobs still due");
    },
    { timeout: 5000, interval: 20 },
  );
}

const created = (id: number) => ({
  event: "message_created",
  id: 1,
  account: { id: 3, name: "Acme" },
  conversation: { id },
});

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await drain();
  await runInDurableObject(hub(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM jobs");
    await state.storage.deleteAlarm();
  });
  vi.restoreAllMocks();
});

describe("worker", () => {
  it("reports health", async () => {
    const response = await call(new Request("https://relay.example.com/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects unsigned, stale, and cross-account Chatwoot webhooks", async () => {
    expect((await chatwootWebhook(created(1), { secret: "wrong" })).status).toBe(401);
    expect((await chatwootWebhook(created(1), { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    // Signed with account 1's secret but claims to be account 3.
    expect((await chatwootWebhook(created(1), { secret: "secret-globex" })).status).toBe(403);
    expect(await (await chatwootWebhook({ event: "contact_updated", account: { id: 3 } })).json()).toMatchObject({
      ignored: true,
    });
  });

  it("dedupes webhook deliveries", async () => {
    const delivery = crypto.randomUUID();
    expect(await (await chatwootWebhook(created(90), { delivery })).json()).toEqual({ ok: true, duplicate: false });
    expect(await (await chatwootWebhook(created(90), { delivery })).json()).toEqual({ ok: true, duplicate: true });
  });

  it("relays a conversation in order from the API, links the post, and only posts new messages later", async () => {
    world.conversation(
      12,
      [
        {
          id: 501,
          content: "My agent will not connect",
          message_type: 0,
          sender: { name: "Jane Doe", type: "contact" },
        },
      ],
      {
        topic: "Billing",
      },
    );
    await chatwootWebhook(created(12));
    await drain();

    const posts = world.webhookPosts();
    expect(posts).toHaveLength(2);
    expect(posts[0]?.thread).toBeNull();
    expect(posts[0]?.body).toMatchObject({
      thread_name: "[Acme #12] Jane Doe — My agent will not connect",
      applied_tags: ["t-acme", "t-open"],
      content:
        "-# via Live chat · Acme — Product App\n-# jane@example.com\n[Open in Chatwoot](<https://chatwoot.example.com/app/accounts/3/conversations/12>)",
    });
    const thread = posts[1]?.thread ?? "";
    expect(thread).toMatch(/^\d{18}$/);
    expect(posts[1]).toEqual({
      thread,
      body: {
        allowed_mentions: { parse: [] },
        content: `My agent will not connect\n-# <@100000000000000777>`,
        username: "Jane Doe",
      },
    });

    // The post URL is merged into the conversation's attributes; other attributes survive.
    const link = world.requests.find((request) => request.url.pathname.endsWith("/custom_attributes"));
    expect(JSON.parse(link?.body ?? "")).toEqual({
      custom_attributes: { discord_thread: `https://discord.com/channels/${GUILD}/${thread}` },
      merge: true,
    });
    expect(world.conversations.get(12)?.custom_attributes).toEqual({
      topic: "Billing",
      discord_thread: `https://discord.com/channels/${GUILD}/${thread}`,
    });
    expect(await hub().ticketForThread(thread)).toEqual({ accountId: 3, conversationId: 12 });

    world.conversations
      .get(12)
      ?.messages.push({ id: 502, content: "Try again", message_type: 1, sender: { name: "Sam", type: "user" } });
    await chatwootWebhook(created(12));
    await drain();
    expect(world.webhookPosts().slice(2)).toEqual([
      { thread, body: { allowed_mentions: { parse: [] }, content: "Try again", username: "Sam · Acme" } },
    ]);
  });

  it("retries a failed message with backoff without skipping it", async () => {
    world.conversation(13, [{ id: 601, content: "hello", message_type: 0 }]);
    world.failReplies = 1;
    await chatwootWebhook(created(13));
    await drain();
    expect(await cursorOf(13)).toBe(0); // the failed message is not marked as relayed

    // Make the backed-off job due now instead of waiting.
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0");
    });
    await setAlarmNow();
    await drain();
    expect(await cursorOf(13)).toBe(601);
    const replies = world.webhookPosts().filter((post) => post.thread);
    expect(replies.map((post) => post.body.content)).toEqual([
      "hello\n-# <@100000000000000777>", // attempt answered with HTTP 500
      "hello\n-# <@100000000000000777>",
    ]);
  });

  it("recovers a missing mapping from the conversation's link attribute instead of opening a second post", async () => {
    const thread = "100000000000020001";
    world.threads.set(thread, FORUM);
    world.conversation(
      14,
      [
        { id: 701, content: "old, relayed by the previous service", message_type: 0 },
        { id: 702, content: "also old", message_type: 1 },
      ],
      { discord_thread: `https://discord.com/channels/${GUILD}/${thread}` },
    );
    await chatwootWebhook(created(14));
    await drain();
    expect(world.webhookPosts()).toEqual([]); // history is not re-posted, no new post
    expect(await hub().ticketForThread(thread)).toEqual({ accountId: 3, conversationId: 14 });

    world.conversations.get(14)?.messages.push({ id: 703, content: "new", message_type: 0 });
    await chatwootWebhook(created(14));
    await drain();
    expect(world.webhookPosts().map((post) => post.thread)).toEqual([thread]);
  });

  it("opens a new post when the linked thread no longer exists", async () => {
    world.conversation(15, [{ id: 801, content: "hi", message_type: 0 }], {
      discord_thread: `https://discord.com/channels/${GUILD}/100000000000029999`,
    });
    await chatwootWebhook(created(15));
    await drain();
    expect(world.webhookPosts()[0]?.thread).toBeNull();
  });

  it("the cron sweep relays conversations whose webhooks never arrived", async () => {
    world.conversation(16, [{ id: 901, content: "missed", message_type: 0 }]);
    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    await drain();
    const sweep = world.requests.find((request) => request.url.pathname === "/api/v1/accounts/3/conversations");
    expect(sweep?.url.searchParams.get("updated_within")).toBe("3600");
    expect(sweep?.url.searchParams.get("status")).toBe("all");
    expect(world.webhookPosts().map((post) => post.body.content)).toContain("missed\n-# <@100000000000000777>");
  });

  it("verifies Discord signatures and answers pings", async () => {
    const pong = await discordInteraction({ type: 1 });
    expect(pong.status).toBe(200);
    expect(await pong.json()).toEqual({ type: 1 });
    expect((await discordInteraction({ type: 1 }, true)).status).toBe(401);
  });

  it("runs a deferred command as the agent and edits the original response", async () => {
    const thread = "100000000000030001";
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id, conversation_id, thread_id, cursor) VALUES (3, 17, ?, 0)",
        thread,
      );
    });
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    const toggle = on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/17/toggle_status", () => json({}));
    world.mock.spy.mockRestore();
    world = new World([profile, toggle]);
    const response = await discordInteraction({
      id: "900001",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 2,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      data: { type: 1, name: "resolve" },
    });
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    await drain();
    await vi.waitFor(() =>
      expect(world.requests.some((request) => request.url.pathname.endsWith("original"))).toBe(true),
    );
    const edit = world.requests.find((request) => request.url.pathname.endsWith("original"));
    expect(decodeURIComponent(edit?.url.pathname ?? "")).toBe(
      "/api/v10/webhooks/100000000000000001/interaction-token/messages/@original",
    );
    expect(JSON.parse(edit?.body ?? "")).toEqual({ content: "✅ Resolved.", allowed_mentions: { parse: [] } });
    const toggled = world.requests.find((request) => request.url.pathname.endsWith("/toggle_status"));
    expect(toggled?.headers.get("api_access_token")).toBe("token-alice");
  });

  it("imports mappings only with the admin token", async () => {
    const lines = [
      JSON.stringify({ accountId: 3, conversationId: 40, threadId: "100000000000040001", lastMessageId: 5 }),
      JSON.stringify({ accountId: 99, conversationId: 41, threadId: "100000000000040002" }),
      "not json",
    ].join("\n");
    const url = "https://relay.example.com/admin/import";
    expect((await call(new Request(url, { method: "POST", body: lines }))).status).toBe(401);
    expect(
      (await call(new Request(url, { method: "POST", body: lines, headers: { authorization: "Bearer nope" } }))).status,
    ).toBe(401);
    const response = await call(
      new Request(url, { method: "POST", body: lines, headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } }),
    );
    expect(await response.json()).toEqual({ imported: 1, skipped: 1, invalidLines: [3] });
    expect(await hub().ticketForThread("100000000000040001")).toEqual({ accountId: 3, conversationId: 40 });
  });
});

function cursorOf(conversationId: number): Promise<number | null> {
  return runInDurableObject(hub(), (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ cursor: number | null }>(
        "SELECT cursor FROM conversations WHERE account_id = 3 AND conversation_id = ?",
        conversationId,
      )
      .toArray();
    return rows[0]?.cursor ?? null;
  });
}

async function setAlarmNow(): Promise<void> {
  await runInDurableObject(hub(), async (_instance, state) => {
    await state.storage.setAlarm(Date.now());
  });
}
