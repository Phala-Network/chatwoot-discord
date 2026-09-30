// End to end through the Worker and the Hub Durable Object (alarms included), with Chatwoot and
// Discord faked at the fetch boundary.

import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { ALICE, json, mockFetch, on, type Recorded, type Route } from "./helpers.ts";

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
    content_type?: string;
    private?: boolean;
    sender?: Record<string, unknown>;
    content_attributes?: Record<string, unknown>;
  }>;
}

/** A tiny Chatwoot + Discord: enough state to exercise the relay end to end. */
class World {
  conversations = new Map<number, FakeConversation>();
  threads = new Map<string, string>(); // thread id -> parent forum
  failReplies = 0;
  rateLimitReplies = 0;
  failPatches = 0;
  failConversations = 0;
  private replies = 0;
  readonly mock: ReturnType<typeof mockFetch>;

  constructor(extra: Route[] = []) {
    this.mock = mockFetch(...extra, ...this.routes());
  }

  conversation(
    id: number,
    messages: FakeConversation["messages"],
    custom_attributes: Record<string, unknown> = {},
    status = "open",
  ) {
    this.conversations.set(id, { id, status, custom_attributes, messages });
  }

  get requests(): Recorded[] {
    return this.mock.requests;
  }

  sent(method: string, path: RegExp): Recorded[] {
    return this.requests.filter((request) => request.method === method && path.test(request.url.pathname));
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
      last_activity_at: Math.floor(Date.now() / 1000),
    };
  }

  private routes(): Route[] {
    const cw = "chatwoot.example.com/api/v1/accounts/3";
    return [
      on("GET", new RegExp(`^${cw}/conversations/(\\d+)$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-1)));
        if (this.failConversations > 0) {
          this.failConversations -= 1;
          return json({ error: "unavailable" }, { status: 503 });
        }
        return conversation
          ? json(this.conversationJson(conversation))
          : json({ error: "Resource could not be found" }, { status: 404 });
      }),
      on("GET", new RegExp(`^${cw}/conversations/(\\d+)/messages$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-2)));
        const after = request.url.searchParams.get("after");
        const before = request.url.searchParams.get("before");
        const messages = (conversation?.messages ?? []).filter(
          (message) =>
            (after === null || message.id > Number(after)) && (before === null || message.id < Number(before)),
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
      on("GET", `${cw}/conversations`, (request) => {
        const all = [...this.conversations.values()].map((c) => this.conversationJson(c));
        return json({ data: { meta: {}, payload: request.url.searchParams.get("page") === "1" ? all : [] } });
      }),
      on("GET", "discord.com/api/v10/applications/@me", () => json({ id: "100000000000000001" })),
      on("GET", `discord.com/api/v10/channels/${FORUM}/webhooks`, () =>
        json([{ id: "1", token: "tok", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      on("GET", `discord.com/api/v10/channels/${FORUM}`, () =>
        json({
          id: FORUM,
          type: 15,
          guild_id: GUILD,
          available_tags: [
            { id: "100000000000000301", name: "Acme" },
            { id: "100000000000000302", name: "open" },
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
      on("PATCH", /^discord\.com\/api\/v10\/channels\/\d+$/, () => {
        if (this.failPatches === 0) return json({});
        this.failPatches -= 1;
        return json({ message: "Internal Server Error" }, { status: 500 });
      }),
      on(
        "DELETE",
        /^discord\.com\/api\/v10\/webhooks\/1\/tok\/messages\/[\w-]+$/,
        () => new Response(null, { status: 204 }),
      ),
      on("POST", "discord.com/api/v10/webhooks/1/tok", (request) => {
        const thread = request.url.searchParams.get("thread_id");
        if (thread) {
          if (this.rateLimitReplies > 0) {
            this.rateLimitReplies -= 1;
            return json({ message: "You are being rate limited.", retry_after: 64.5, global: false }, { status: 429 });
          }
          if (this.failReplies > 0) {
            this.failReplies -= 1;
            return json({ message: "Internal Server Error" }, { status: 500 });
          }
          this.replies += 1;
          return json({ id: `m-${this.replies}`, channel_id: thread });
        }
        const id = nextThreadId();
        this.threads.set(id, FORUM);
        return json({ id: "card", channel_id: id });
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

/** The triage bot's hook: signed like a Chatwoot webhook, with the shared secret. */
async function triageHook(payload: unknown, secret = "triage-hook-secret-0123456789abcdef") {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return call(
    new Request("https://relay.example.com/triage/answered", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-timestamp": ts,
        "x-signature": `sha256=${await hmac(secret, `${ts}.${body}`)}`,
      },
    }),
  );
}

/** The ticket buttons: the answering row, then the acting row. */
const ACTIONS = ["ticket:take", "ticket:resolve", "ticket:snooze", "ticket:block", "ticket:manage"];
const ALL_BUTTONS = [["ticket:reply"], ACTIONS];
const DRAFT_BUTTONS = [["ticket:draft", "ticket:reply"], ACTIONS];

/** The custom id of a posted message's highlighted (primary) button. */
function primary(body: unknown): string | undefined {
  const rows = (body as { components?: Array<{ components: Array<{ custom_id: string; style: number }> }> }).components;
  return rows?.flatMap((row) => row.components).find((button) => button.style === 1)?.custom_id;
}

/** The custom ids of a posted message's buttons, row by row. */
function buttons(body: unknown): string[][] | undefined {
  return (body as { components?: Array<{ components: Array<{ custom_id: string }> }> }).components?.map((row) =>
    row.components.map((button) => button.custom_id),
  );
}

async function discordInteraction(payload: unknown, tamper = false) {
  const request = await signedInteraction(payload, Math.floor(Date.now() / 1000), tamper);
  return call(request());
}

/** A signed interaction request, which can be sent again unchanged (a replay). */
async function signedInteraction(payload: unknown, timestampSeconds: number, tamper = false) {
  const body = JSON.stringify(payload);
  const timestamp = String(timestampSeconds);
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.TEST_DISCORD_PRIVATE_JWK),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, encoder.encode(timestamp + body)));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return () =>
    new Request("https://relay.example.com/discord/interactions", {
      method: "POST",
      body: tamper ? body.replace("1", "2") : body,
      headers: { "content-type": "application/json", "x-signature-ed25519": hex, "x-signature-timestamp": timestamp },
    });
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
 * Waits until no job is due. Jobs run from the Durable Object's own alarm, which fires on its
 * own; running alarm() by hand as well would overlap it, which Cloudflare never does.
 */
async function drain(): Promise<void> {
  await vi.waitFor(
    async () => {
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
    state.storage.sql.exec("DELETE FROM interactions");
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

  it("ignores events the relay does not use", async () => {
    const conversationCreated = { event: "conversation_created", id: 12, account: { id: 3 } };
    const edited = { ...created(12), event: "message_updated", content_attributes: {} };
    for (const event of [conversationCreated, edited]) {
      expect(await (await chatwootWebhook(event)).json()).toEqual({ ok: true, ignored: true });
    }
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
      applied_tags: ["100000000000000301", "100000000000000302"],
      content:
        "-# via Live chat · Acme — Product App\n-# jane@example.com\n[Open in Chatwoot](<https://chatwoot.example.com/app/accounts/3/conversations/12>)",
    });
    // The card and every message carry the ticket buttons, but a message the triage bot answers
    // has them after the answer (see the triage hook test); activity lines have none.
    expect(buttons(posts[0]?.body)).toEqual(ALL_BUTTONS);
    const thread = posts[1]?.thread ?? "";
    expect(thread).toMatch(/^\d{18}$/);
    expect(posts[1]).toMatchObject({
      thread,
      body: {
        allowed_mentions: { parse: [] },
        content: `My agent will not connect\n-# <@100000000000000777>`,
        username: "Jane Doe",
        avatar_url: "https://gravatar.com/avatar/?d=mp&f=y&s=256",
      },
    });
    expect(buttons(posts[1]?.body)).toBeUndefined();

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
    const later = world.webhookPosts().slice(2);
    expect(later).toMatchObject([
      {
        thread,
        body: {
          allowed_mentions: { parse: [] },
          avatar_url: "https://chatwoot.example.com/favicon-512x512.png",
          content: "Try again",
          username: "Sam · Acme",
        },
      },
    ]);
    expect(buttons(later[0]?.body)).toEqual(ALL_BUTTONS);
  });

  it("posts the ticket buttons after the triage bot's answer when its signed hook says it answered", async () => {
    world.conversation(21, [{ id: 701, content: "help", message_type: 0 }]);
    await chatwootWebhook(created(21));
    await drain();
    const thread = world.webhookPosts().at(-1)?.thread ?? "";
    expect(thread).toMatch(/^\d{18}$/);
    const before = world.webhookPosts().length;

    expect((await triageHook({ threadId: thread, draft: true }, "wrong-secret-0123456789abcdef0123")).status).toBe(401);
    expect((await triageHook({ threadId: "not a thread", draft: true })).status).toBe(400);
    expect((await triageHook({ threadId: thread })).status).toBe(400);
    const answered = async (draft: boolean) => {
      expect((await triageHook({ threadId: thread, draft })).status).toBe(200);
      // It waits a moment, so the answer (sent right after the hook) lands first.
      await runInDurableObject(hub(), (_instance, state) => {
        state.storage.sql.exec("UPDATE jobs SET not_before = 0");
      });
      await setAlarmNow();
      await drain();
      return world.webhookPosts().at(-1);
    };

    const bar = await answered(true);
    expect(world.webhookPosts()).toHaveLength(before + 1);
    expect(bar).toMatchObject({ thread, body: { username: "Chatwoot", allowed_mentions: { parse: [] } } });
    expect(bar?.body).not.toHaveProperty("content");
    // Under an answer with a draft, "Use draft" is the button to press; elsewhere "Reply" is.
    expect(buttons(bar?.body)).toEqual(DRAFT_BUTTONS);
    expect(primary(bar?.body)).toBe("ticket:draft");
    expect(primary(world.webhookPosts().find((post) => post.thread === null)?.body)).toBe("ticket:reply");
    // An answer without a draft (spam, already answered) gets no "Use draft".
    expect(buttons((await answered(false))?.body)).toEqual(ALL_BUTTONS);
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

  it("waits out a rate limit as long as Discord asks, without counting it as a failed attempt", async () => {
    world.conversation(40, [{ id: 4001, content: "hello", message_type: 0 }]);
    world.rateLimitReplies = 12; // more rounds than a job's attempt limit
    await chatwootWebhook(created(40));
    await drain();
    for (let round = 1; round < 12; round += 1) {
      expect(await jobAttempts("conversation:3:40")).toBe(0);
      expect(await jobDelay("conversation:3:40")).toBeGreaterThan(60_000);
      await makeJobsDue();
      await drain();
    }
    await makeJobsDue();
    await drain();
    expect(await jobAttempts("conversation:3:40")).toBeUndefined();
    expect(await cursorOf(40)).toBe(4001);
    const replies = world.webhookPosts().filter((post) => post.thread);
    expect(replies.at(-1)?.body.content).toBe("hello\n-# <@100000000000000777>");
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
    const pages = world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations$/);
    // Newest activity first; the empty second page ends the sweep.
    expect(pages.map((request) => Object.fromEntries(request.url.searchParams))).toEqual([
      { status: "all", assignee_type: "all", page: "1" },
      { status: "all", assignee_type: "all", page: "2" },
    ]);
    expect(world.webhookPosts().map((post) => post.body.content)).toContain("missed\n-# <@100000000000000777>");
  });

  it("the sweep stops at conversations without activity in its window", async () => {
    world.conversation(18, [{ id: 1001, content: "old", message_type: 0 }]);
    const old = on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", () =>
      json({
        data: {
          meta: {},
          payload: [{ id: 18, status: "open", last_activity_at: Math.floor(Date.now() / 1000) - 7200, messages: [] }],
        },
      }),
    );
    world.mock.spy.mockRestore();
    world = new World([old]);
    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    await drain();
    expect(world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations$/)).toHaveLength(1);
    expect(world.webhookPosts()).toEqual([]);
  });

  it("does not post a message twice when updating the post fails afterwards", async () => {
    world.conversation(19, [{ id: 1101, content: "thanks, solved", message_type: 0 }], {}, "resolved");
    world.failPatches = 1;
    await chatwootWebhook(created(19));
    await drain();
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0");
    });
    await setAlarmNow();
    await drain();
    expect(world.webhookPosts().map((post) => post.body.content)).toEqual([
      expect.stringContaining("Open in Chatwoot"),
      "thanks, solved\n-# <@100000000000000777>",
    ]);
    // The first update failed; the retry unarchives with the tags, then archives.
    expect(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).map((request) => JSON.parse(request.body))).toEqual([
      { archived: false, applied_tags: ["100000000000000301"] },
      { archived: false, applied_tags: ["100000000000000301"] },
      { archived: true },
    ]);
  });

  it("removes the Discord messages of a message deleted in Chatwoot", async () => {
    world.conversation(21, [
      { id: 1201, content: "first", message_type: 0 },
      { id: 1202, content: "wrong conversation, sorry", message_type: 1 },
    ]);
    await chatwootWebhook(created(21));
    await drain();
    const deleted = world.conversations.get(21)?.messages[1];
    if (deleted) Object.assign(deleted, { content: "This message was deleted", content_attributes: { deleted: true } });
    await chatwootWebhook({
      ...created(21),
      event: "message_updated",
      id: 1202,
      content_attributes: { deleted: true },
    });
    // A deletion reported for a message that was not deleted changes nothing.
    await chatwootWebhook({
      ...created(21),
      event: "message_updated",
      id: 1201,
      content_attributes: { deleted: true },
    });
    await drain();
    const deletes = world.sent("DELETE", /^\/api\/v10\/webhooks\/1\/tok\/messages\//);
    expect(deletes.map((request) => request.url.pathname.split("/").at(-1))).toEqual(["m-2"]);
    expect(deletes[0]?.url.searchParams.get("thread_id")).toBe(world.webhookPosts()[1]?.thread);
  });

  it("posts a customer's response to an interactive message once, after Chatwoot's API confirms it", async () => {
    const question = { id: 1402, content: "How did we do?", message_type: 3, content_type: "input_csat" };
    world.conversation(23, [{ id: 1401, content: "thanks, all good", message_type: 0 }, question], {}, "resolved");
    await chatwootWebhook(created(23));
    await drain();
    const thread = world.webhookPosts()[1]?.thread;
    const posts = world.webhookPosts().length;
    const rated = (rating: number) => ({ submitted_values: { csat_survey_response: { rating } } });
    const updated = (rating: number) => ({
      ...created(23),
      event: "message_updated",
      id: 1402,
      content_type: "input_csat",
      content_attributes: rated(rating),
    });

    // The webhook claims a response the API does not have yet: nothing is posted.
    await chatwootWebhook(updated(5));
    await drain();
    expect(world.webhookPosts()).toHaveLength(posts);

    Object.assign(question, { content_attributes: rated(5) });
    await chatwootWebhook(updated(5));
    await drain();
    // Another update of the same response (e.g. its status) is not posted again.
    await chatwootWebhook(updated(5));
    await drain();
    expect(world.webhookPosts().slice(posts)).toEqual([
      {
        thread,
        body: {
          content: "How did we do?\n\n**CSAT:**\n• Rating: 5",
          username: "Jane Doe",
          avatar_url: "https://gravatar.com/avatar/?d=mp&f=y&s=256",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    // Posting unarchived the resolved post; it is archived again.
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: true,
    });

    // A changed response is posted again.
    Object.assign(question, { content_attributes: rated(4) });
    await chatwootWebhook(updated(4));
    await drain();
    expect(
      world
        .webhookPosts()
        .slice(posts)
        .map((post) => post.body.content),
    ).toEqual(["How did we do?\n\n**CSAT:**\n• Rating: 5", "How did we do?\n\n**CSAT:**\n• Rating: 4"]);
  });

  it("closes the post of a conversation deleted in Chatwoot", async () => {
    world.conversation(22, [{ id: 1301, content: "hello", message_type: 0 }]);
    await chatwootWebhook(created(22));
    await drain();
    const thread = world.webhookPosts()[1]?.thread ?? "";
    world.conversations.delete(22);
    await chatwootWebhook(created(22));
    await drain();
    expect(world.webhookPosts().at(-1)).toEqual({
      thread,
      body: {
        content: "This conversation no longer exists in Chatwoot.",
        username: "Chatwoot",
        avatar_url: "https://chatwoot.example.com/favicon-512x512.png",
        allowed_mentions: { parse: [] },
      },
    });
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: true,
    });
    expect(await hub().ticketForThread(thread)).toBeNull();
  });

  it("drops unreadable and unknown jobs", async () => {
    await runInDurableObject(hub(), async (_instance, state) => {
      const insert = "INSERT INTO jobs (key, priority, payload, not_before, created_at) VALUES (?, 2, ?, 0, 0)";
      state.storage.sql.exec(insert, "garbage", "{not json");
      state.storage.sql.exec(insert, "unknown", JSON.stringify({ type: "reindex", accountId: 3 }));
      state.storage.sql.exec(insert, "partial", JSON.stringify({ type: "conversation", accountId: 3 }));
      await state.storage.setAlarm(Date.now());
    });
    await drain();
    const left = await runInDurableObject(hub(), (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").one(),
    );
    expect(left.n).toBe(0);
    expect(world.requests).toEqual([]);
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

  it("runs a replayed signed command once, and refuses an old signed request", async () => {
    const thread = "100000000000030002";
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id, conversation_id, thread_id, cursor) VALUES (3, 18, ?, 0)",
        thread,
      );
    });
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    const toggle = on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/18/toggle_status", () => json({}));
    world.mock.spy.mockRestore();
    world = new World([profile, toggle]);
    const resolve = (id: string) => ({
      id,
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 2,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      data: { type: 1, name: "resolve" },
    });
    const now = Math.floor(Date.now() / 1000);
    const replayed = await signedInteraction(resolve("900003"), now);
    // Sent while the first is queued, and again after it ran.
    expect((await call(replayed())).status).toBe(200);
    expect((await call(replayed())).status).toBe(200);
    await drain();
    expect((await call(replayed())).status).toBe(200);
    await drain();
    expect(world.requests.filter((request) => request.url.pathname.endsWith("/toggle_status"))).toHaveLength(1);

    const old = await signedInteraction(resolve("900004"), now - 600);
    expect((await call(old())).status).toBe(401);
  });

  it("drops a command whose interaction token expires before it could report the result", async () => {
    const job = {
      interactionId: "900002",
      applicationId: "100000000000000001",
      token: "interaction-token",
      discordUserId: ALICE,
      accountId: 3,
      conversationId: 17,
      action: { type: "message", private: false, content: "Hello", files: [] },
    };
    const queuedAt = Date.now() - 13 * 60 * 1000;
    await runInDurableObject(hub(), async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO jobs (key, priority, payload, not_before, created_at) VALUES (?, 0, ?, ?, ?)",
        `command:${job.interactionId}`,
        JSON.stringify({ type: "command", job }),
        queuedAt,
        queuedAt,
      );
      await state.storage.setAlarm(Date.now());
    });
    await drain();
    // The token still works: the invoker learns that nothing was done.
    expect(world.requests.map((request) => [request.method, decodeURIComponent(request.url.pathname)])).toEqual([
      ["PATCH", "/api/v10/webhooks/100000000000000001/interaction-token/messages/@original"],
    ]);
    expect(JSON.parse(world.requests[0]?.body ?? "")).toEqual({
      content: "❌ This could not start in time, so nothing was done. Please try again.",
      allowed_mentions: { parse: [] },
    });
  });

  it("syncs a conversation event after a short wait, so the change's activity message is posted with it", async () => {
    world.conversation(30, [{ id: 3001, content: "hello", message_type: 0 }]);
    await chatwootWebhook(created(30));
    await drain();
    const conversation = world.conversations.get(30);
    if (conversation) conversation.status = "resolved";
    await chatwootWebhook({ event: "conversation_status_changed", id: 30, account: { id: 3 } });
    // Chatwoot creates "Resolved by …" afterwards, and sends no webhook for it.
    conversation?.messages.push({ id: 3002, content: "Resolved by Sam", message_type: 2 });
    expect(await jobDelay("conversation:3:30")).toBeGreaterThan(5000);

    await makeJobsDue();
    await drain();
    expect(world.webhookPosts().at(-1)?.body.content).toBe("_Resolved by Sam_");
    expect(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).map((request) => JSON.parse(request.body))).toEqual([
      { archived: false, applied_tags: ["100000000000000301"] },
      { archived: true },
    ]);

    if (conversation) conversation.status = "open";
    await chatwootWebhook({ event: "conversation_updated", id: 30, account: { id: 3 } });
    await makeJobsDue();
    await drain();
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: false,
      applied_tags: ["100000000000000301", "100000000000000302"],
    });
  });

  it("keeps retrying a job that keeps failing, at most every 30 minutes, so an outage loses nothing", async () => {
    world.conversation(31, [{ id: 3101, content: "hello", message_type: 0 }]);
    world.failConversations = 100;
    await chatwootWebhook(created(31));
    await drain();
    expect(await jobAttempts("conversation:3:31")).toBe(1);

    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET attempts = 20, not_before = 0 WHERE key = 'conversation:3:31'");
    });
    await setAlarmNow();
    await drain();
    expect(await jobAttempts("conversation:3:31")).toBe(21);
    const due = await runInDurableObject(hub(), (_instance, state) =>
      state.storage.sql
        .exec<{ not_before: number }>("SELECT not_before FROM jobs WHERE key = 'conversation:3:31'")
        .one(),
    );
    expect(due.not_before - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);

    // Once Chatwoot answers again, the retry relays the message.
    world.failConversations = 0;
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0 WHERE key = 'conversation:3:31'");
    });
    await setAlarmNow();
    await drain();
    expect(world.webhookPosts().at(-1)?.body.content).toBe("hello\n-# <@100000000000000777>");
    expect(await jobAttempts("conversation:3:31")).toBeUndefined();
  });

  it("the sweep queues only conversations whose post is behind or out of date", async () => {
    world.conversation(32, [{ id: 3201, content: "hello", message_type: 0 }]);
    await chatwootWebhook(created(32));
    await drain();
    const reads = () => world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations\/32$/).length;
    const before = reads();

    await sweep();
    expect(reads()).toBe(before); // up to date: not queued

    const conversation = world.conversations.get(32);
    if (conversation) conversation.status = "resolved"; // missed webhook
    await sweep();
    expect(reads()).toBe(before + 1);
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: true,
    });
  });

  it("a sweep longer than a run's page limit continues where it stopped, down to its window's start", async () => {
    const start = Math.floor(Date.now() / 1000);
    // 11 pages of recent conversations; only the last one is behind (a message never relayed).
    const busy = on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", (request) => {
      const page = Number(request.url.searchParams.get("page"));
      const payload =
        page > 11
          ? []
          : Array.from({ length: 25 }, (_, index) => {
              const id = 50000 + (page - 1) * 25 + index;
              return {
                id,
                status: "open",
                last_activity_at: start - id + 50000,
                messages: id === 50274 ? [{ id: 1 }] : [],
              };
            });
      return json({ data: { meta: {}, payload } });
    });
    world.mock.spy.mockRestore();
    world = new World([busy]);
    await sweep();
    const pages = world
      .sent("GET", /^\/api\/v1\/accounts\/3\/conversations$/)
      .map((request) => Number(request.url.searchParams.get("page")));
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations\/50274$/).length).toBeGreaterThan(0);
    const cache = await runInDurableObject(hub(), (_instance, state) =>
      state.storage.sql.exec<{ key: string }>("SELECT key FROM cache WHERE key LIKE 'sweep:3:%'").toArray(),
    );
    expect(cache.map((row) => row.key)).toEqual(["sweep:3:last"]);
  });

  it("routes a new ticket of a routed account once, with Jev", async () => {
    const globex = "chatwoot.example.com/api/v1/accounts/1";
    let assignee: { id: number; name: string } | null = null;
    world = new World([
      on("GET", `${globex}/conversations/7`, () =>
        json({
          id: 7,
          status: "open",
          inbox_id: 2,
          custom_attributes: {},
          meta: { sender: { name: "Jane Doe" }, assignee, channel: "Channel::Email" },
          messages: [{ id: 70 }],
          last_activity_at: Math.floor(Date.now() / 1000),
        }),
      ),
      on("GET", `${globex}/conversations/7/messages`, () =>
        json({ payload: [{ id: 70, content: "I was charged twice", message_type: 0 }] }),
      ),
      on("GET", `${globex}/inboxes/2`, () => json({ id: 2, name: "Globex — Email" })),
      on("POST", `${globex}/conversations/7/assignments`, (request) => {
        assignee = { id: JSON.parse(request.body).assignee_id, name: "Cloud" };
        return json({});
      }),
      on("POST", `${globex}/conversations/7/custom_attributes`, () => json({})),
      on("POST", `${globex}/conversations/7/labels`, () => json({})),
      on("POST", "api.typesafe.ai/v1/systemone", () =>
        json({
          answers: {
            owner: { type: "choice", choice: "cloud", probabilities: { cloud: 0.9, unclear: 0.1 } },
            topic: { type: "choice", choice: "billing", probabilities: { billing: 1 } },
          },
        }),
      ),
    ]);
    const event = { event: "message_created", id: 1, account: { id: 1, name: "Globex" }, conversation: { id: 7 } };

    expect((await chatwootWebhook(event, { secret: "secret-globex" })).status).toBe(200);
    await drain();
    expect((await chatwootWebhook(event, { secret: "secret-globex" })).status).toBe(200);
    await drain();

    expect(world.sent("POST", /^\/v1\/systemone$/)).toHaveLength(1);
    expect(world.sent("POST", /\/accounts\/1\/conversations\/7\/assignments$/).map((r) => JSON.parse(r.body))).toEqual([
      { assignee_id: 6 },
    ]);
    expect(world.sent("POST", /\/accounts\/1\/conversations\/7\/labels$/).map((r) => JSON.parse(r.body))).toEqual([
      { labels: ["billing"] },
    ]);
  });

  it("closes the post when a command finds its conversation deleted", async () => {
    world.conversation(33, [{ id: 3301, content: "spam", message_type: 0 }]);
    await chatwootWebhook(created(33));
    await drain();
    const thread = world.webhookPosts()[1]?.thread ?? "";
    world.conversations.delete(33);
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    world.mock.spy.mockRestore();
    const conversations = world.conversations;
    const threads = world.threads;
    world = new World([profile]);
    world.conversations = conversations;
    world.threads = threads;
    await discordInteraction({
      id: "900003",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 2,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      data: { type: 1, name: "block" },
    });
    await drain();
    await vi.waitFor(async () => expect(await hub().ticketForThread(thread)).toBeNull());
    expect(world.webhookPosts().at(-1)?.body.content).toBe("This conversation no longer exists in Chatwoot.");
  });
});

async function sweep(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
  await drain();
}

function jobAttempts(key: string): Promise<number | undefined> {
  return runInDurableObject(hub(), (_instance, state) => {
    const rows = state.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM jobs WHERE key = ?", key).toArray();
    return rows[0]?.attempts;
  });
}

/** How long until a queued job is due. */
function jobDelay(key: string): Promise<number> {
  return runInDurableObject(hub(), (_instance, state) => {
    const row = state.storage.sql.exec<{ at: number }>("SELECT not_before AS at FROM jobs WHERE key = ?", key).one();
    return row.at - Date.now();
  });
}

async function makeJobsDue(): Promise<void> {
  await runInDurableObject(hub(), (_instance, state) => {
    state.storage.sql.exec("UPDATE jobs SET not_before = 0");
  });
  await setAlarmNow();
}

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
