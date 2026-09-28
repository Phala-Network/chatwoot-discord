// The processor against the real Store (in a Durable Object's SQLite), with Chatwoot and
// Discord faked at the fetch boundary, so every request counts against the budget.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget.ts";
import { chatwootClient } from "../src/chatwoot/api.ts";
import type { Settings } from "../src/config.ts";
import { DiscordForum } from "../src/discord/forum.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { minimumBudget, requestsPerMessage } from "../src/relay/limits.ts";
import { type ProcessOutcome, processConversation, relayFor } from "../src/relay/processor.ts";
import { processMessageUpdate } from "../src/relay/updates.ts";
import { Store } from "../src/store.ts";
import { ALICE, BOB, FORUM, json, mockFetch, on, type Recorded, TRIAGE, testSettings } from "./helpers.ts";

const GUILD = "100000000000000044";
const now = () => Math.floor(Date.now() / 1000);

interface FakeMessage {
  id: number;
  content: string | null;
  message_type: number;
  private?: boolean;
  created_at?: number;
  status?: string;
  content_type?: string;
  content_attributes?: Record<string, unknown>;
  sender?: { id: number; type: string; name?: string; thumbnail?: string };
  attachments?: Array<Record<string, unknown>>;
}

/** One Chatwoot conversation (#12 in account 3) and its messages, and the Discord forum. */
class World {
  conversation: Record<string, unknown> = {
    id: 12,
    status: "open",
    inbox_id: 2,
    custom_attributes: {},
    meta: { sender: { name: "Jane Doe" }, channel: "Channel::WebWidget" },
  };
  messages: FakeMessage[] = [];
  failLinks = 0;
  /** Assignee announcements Discord fails before accepting them. */
  failAnnouncements = 0;
  /** Posts deleted in Discord. */
  goneThreads = new Set<string>();
  /** Discord's answer to posting into a thread, while it fails. */
  threadFailure: (() => Response) | undefined;
  /** Discord users by id; others are unknown to Discord. */
  discordUsers: Record<string, { avatar: string | null; discriminator: string }> = {};
  private threads = 0;
  readonly requests: Recorded[];

  constructor() {
    const base = "chatwoot.example.com/api/v1/accounts/3";
    this.requests = mockFetch(
      on("GET", `${base}/conversations/12`, () => json(this.conversation)),
      on("GET", `${base}/conversations/12/messages`, (request) => {
        const after = request.url.searchParams.get("after");
        const before = request.url.searchParams.get("before");
        const found = this.messages.filter(
          (message) =>
            (after === null || message.id > Number(after)) && (before === null || message.id < Number(before)),
        );
        return json({ meta: {}, payload: after === null ? found.slice(-20) : found.slice(0, 100) });
      }),
      on("POST", `${base}/conversations/12/custom_attributes`, (request) => {
        if (this.failLinks > 0) {
          this.failLinks -= 1;
          return json({ error: "unavailable" }, { status: 503 });
        }
        const attributes = JSON.parse(request.body).custom_attributes;
        this.conversation.custom_attributes = { ...Object(this.conversation.custom_attributes), ...attributes };
        return json({});
      }),
      on("GET", `${base}/inboxes/2`, () => json({ id: 2, name: "Web" })),
      on("GET", `discord.com/api/v10/channels/${FORUM}/webhooks`, () =>
        json([{ id: "1", token: "tok", type: 1, name: "Chatwoot" }]),
      ),
      on("GET", `discord.com/api/v10/channels/${FORUM}`, () =>
        json({ id: FORUM, guild_id: GUILD, available_tags: [] }),
      ),
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+$/, (request) => {
        const id = request.url.pathname.split("/").at(-1) ?? "";
        return this.goneThreads.has(id)
          ? json({ message: "Unknown Channel", code: 10003 }, { status: 404 })
          : json({ id, parent_id: FORUM });
      }),
      on("PATCH", /^discord\.com\/api\/v10\/channels\/\d+$/, () => json({})),
      on("GET", /^discord\.com\/api\/v10\/users\/\d+$/, (request) => {
        const id = request.url.pathname.split("/").at(-1) ?? "";
        const user = this.discordUsers[id];
        return user
          ? json({ id, username: "agent", ...user })
          : json({ message: "Unknown User", code: 10013 }, { status: 404 });
      }),
      on(
        "PUT",
        /^discord\.com\/api\/v10\/channels\/\d+\/thread-members\/\d+$/,
        () => new Response(null, { status: 204 }),
      ),
      on(
        "DELETE",
        /^discord\.com\/api\/v10\/webhooks\/1\/tok\/messages\/.+$/,
        () => new Response(null, { status: 204 }),
      ),
      on("POST", "discord.com/api/v10/webhooks/1/tok", (request) => {
        const thread = request.url.searchParams.get("thread_id");
        if (thread && this.threadFailure) return this.threadFailure();
        if (
          thread &&
          this.failAnnouncements > 0 &&
          String(JSON.parse(request.body).content).startsWith("-# Assigned to")
        ) {
          this.failAnnouncements -= 1;
          return json({ message: "unavailable" }, { status: 503 });
        }
        if (thread) return json({ id: `m-${this.requests.length}`, channel_id: thread });
        this.threads += 1;
        return json({ id: "card", channel_id: `20000000000000000${this.threads}` });
      }),
    ).requests;
  }

  /** The contents posted into threads. */
  replies(): string[] {
    return this.posts()
      .filter((post) => post.thread)
      .map((post) => String(post.body.content));
  }

  posts(): Array<{ thread: string | null; body: Record<string, unknown> }> {
    return this.sent("POST", "/webhooks/1/tok").map((request) => ({
      thread: request.url.searchParams.get("thread_id"),
      body: JSON.parse(request.body),
    }));
  }

  sent(method: string, path: string): Recorded[] {
    return this.requests.filter((request) => request.method === method && request.url.pathname.endsWith(path));
  }
}

async function withStore<T>(run: (store: Store) => Promise<T>): Promise<T> {
  return runInDurableObject(env.HUB.getByName(`processor-${crypto.randomUUID()}`), (_instance, state) => {
    const store = new Store(state.storage.sql);
    store.migrate();
    return run(store);
  });
}

/** What the Hub gives a job: services over one invocation's budget. */
function context(store: Store, settings: Settings, limit = settings.config.relay.subrequestBudget) {
  const budget = new Budget(limit);
  const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, "relay-token", budget.fetch);
  const rest = new DiscordRest("bot", budget.fetch);
  const forum = new DiscordForum(rest, store);
  return { settings, store, forum, rest, budget, chatwoot, relay: relayFor(settings, forum, store) };
}

/** Runs the conversation job until it is done, each run with a fresh budget, like the Hub does. */
async function sync(store: Store, settings: Settings, limit?: number): Promise<ProcessOutcome[]> {
  const outcomes: ProcessOutcome[] = [];
  for (let run = 0; run < 30; run += 1) {
    const outcome = await processConversation(context(store, settings, limit), 3, 12);
    outcomes.push(outcome);
    if (outcome === "done") return outcomes;
  }
  throw new Error("never finished");
}

afterEach(() => vi.restoreAllMocks());

describe("processConversation", () => {
  it("starts after the cutover watermark, for new and adopted posts alike", async () => {
    const settings = testSettings({ relay: { startAfterMessageId: 500 } });
    const world = new World();
    world.messages = [
      { id: 499, content: "before the cutover", message_type: 0 },
      { id: 500, content: "the other relay's last", message_type: 0 },
      { id: 501, content: "after", message_type: 0 },
    ];
    await withStore(async (store) => {
      await sync(store, settings);
      expect(world.replies()).toEqual([`after\n-# <@${TRIAGE}>`]);
    });

    // An adopted post (linked from the conversation) continues after the watermark too.
    world.conversation.custom_attributes = {
      discord_thread: `https://discord.com/channels/${GUILD}/300000000000000001`,
    };
    const before = world.posts().length;
    await withStore(async (store) => {
      await sync(store, settings);
      expect(world.posts().slice(before)).toEqual([
        { thread: "300000000000000001", body: expect.objectContaining({ content: `after\n-# <@${TRIAGE}>` }) },
      ]);
      expect(store.conversation(3, 12)?.cursor).toBe(501);
    });
  });

  it("relays an older conversation's history without calling anyone, then notifies on live messages", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "last month", message_type: 0, created_at: now() - 30 * 86400 },
      { id: 2, content: "an answer", message_type: 1, created_at: now() - 30 * 86400 },
      { id: 3, content: "just now", message_type: 0, created_at: now() - 5 },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      expect(world.replies()).toEqual(["last month", "an answer", `just now\n-# <@${TRIAGE}>`]);
    });
  });

  it("pages through more than 100 messages in one run", async () => {
    const world = new World();
    world.messages = Array.from({ length: 130 }, (_, index) => ({
      id: index + 1,
      content: `n${index + 1}`,
      message_type: 1,
    }));
    await withStore(async (store) => {
      expect(await sync(store, testSettings(), 1000)).toEqual(["done"]);
      expect(world.replies()).toEqual(world.messages.map((message) => message.content));
      const pages = world.sent("GET", "/messages").map((request) => request.url.searchParams.get("after"));
      expect(pages).toEqual(["0", "100"]);
    });
  });

  it("yields before the subrequest budget runs out and resumes without posting anything twice", async () => {
    const settings = testSettings();
    const world = new World();
    world.messages = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      content: `n${index + 1}`,
      message_type: 1,
    }));
    const limit = requestsPerMessage(settings.config.relay.maxChunks) + 10;
    await withStore(async (store) => {
      const outcomes = await sync(store, settings, limit);
      expect(outcomes.length).toBeGreaterThan(2);
      expect(outcomes.slice(0, -1).every((outcome) => outcome === "yield")).toBe(true);
      expect(world.replies()).toEqual(world.messages.map((message) => message.content));
    });
  });

  it("relays a message in its worst case within the smallest budget the configuration accepts", async () => {
    const settings = testSettings({ relay: { maxChunks: 10, subrequestBudget: minimumBudget(10) } });
    const world = new World();
    // The link attribute names a post deleted in Discord: checked, then a new post is opened.
    world.goneThreads.add("300000000000000009");
    world.conversation.custom_attributes = {
      discord_thread: `https://discord.com/channels/${GUILD}/300000000000000009`,
    };
    world.discordUsers = { [BOB]: { avatar: "a_bob", discriminator: "0" } };
    world.messages = [
      { id: 1, content: "x\n".repeat(15_000), message_type: 1, sender: { id: 43, type: "user", name: "Bob" } },
    ];
    await withStore(async (store) => {
      expect(await sync(store, settings)).toEqual(["done"]);
      const replies = world.replies();
      expect(replies).toHaveLength(11);
      expect(replies.at(-1)).toMatch(/^-# Message truncated/);
    });
  });

  it.each([
    [
      "a rate limit",
      () => json({ message: "You are being rate limited.", retry_after: 64.5, global: false }, { status: 429 }),
    ],
    ["a server error", () => json({ message: "Internal Server Error" }, { status: 500 })],
    ["missing permissions", () => json({ message: "Missing Permissions", code: 50013 }, { status: 403 })],
  ])("never skips a message because of %s, however often it fails", async (_name, failure) => {
    const settings = testSettings();
    const world = new World();
    world.messages = [
      { id: 1, content: "first", message_type: 1 },
      { id: 2, content: "second", message_type: 1 },
    ];
    world.threadFailure = failure;
    await withStore(async (store) => {
      // Every job attempt fails, far more often than relay.maxAttempts.
      for (let attempt = 0; attempt < settings.config.relay.maxAttempts * 2; attempt += 1) {
        await expect(processConversation(context(store, settings), 3, 12)).rejects.toThrow(/Discord HTTP/);
      }
      expect(store.conversation(3, 12)?.cursor).toBe(0);
      world.threadFailure = undefined;
      await sync(store, settings);
      // Each failed attempt was at the first message; "second" never went ahead of it.
      const attempts = settings.config.relay.maxAttempts * 2;
      expect(world.replies()).toEqual([...Array<string>(attempts + 1).fill("first"), "second"]);
    });
  });

  it("skips a message Discord keeps refusing as invalid, with a notice, after relay.maxAttempts", async () => {
    const settings = testSettings();
    const { maxAttempts } = settings.config.relay;
    const world = new World();
    world.messages = [{ id: 1, content: "first", message_type: 1 }];
    await withStore(async (store) => {
      await sync(store, settings);
      world.messages.push({ id: 2, content: "refused", message_type: 1 });
      // Refused on every attempt; the notice afterwards is accepted.
      let refusals = maxAttempts;
      world.threadFailure = () => {
        refusals -= 1;
        return refusals >= 0
          ? json({ message: "Invalid Form Body", code: 50035 }, { status: 400 })
          : json({ id: "notice", channel_id: "x" });
      };
      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        await expect(processConversation(context(store, settings), 3, 12)).rejects.toThrow(/Discord HTTP 400/);
      }
      expect(await processConversation(context(store, settings), 3, 12)).toBe("done");
      expect(store.conversation(3, 12)?.cursor).toBe(2);
      expect(world.posts().at(-1)?.body.content).toBe(
        "⚠️ Chatwoot message 2 could not be relayed. Check it in Chatwoot.",
      );
    });
  });

  it("links the post from its conversation, failing the job for a retry when that fails", async () => {
    const world = new World();
    world.messages = [{ id: 1, content: "hello", message_type: 0 }];
    world.failLinks = 1;
    await withStore(async (store) => {
      const settings = testSettings();
      await expect(sync(store, settings)).rejects.toThrow();
      expect(world.conversation.custom_attributes).toEqual({});
      // The retry, with no new message, only links.
      await sync(store, settings);
      const link = `https://discord.com/channels/${GUILD}/${store.conversation(3, 12)?.threadId}`;
      expect(world.conversation.custom_attributes).toEqual({ discord_thread: link });
      // Linked: later syncs do not write it again.
      await sync(store, settings);
      expect(world.sent("POST", "/custom_attributes")).toHaveLength(2);
      expect(world.replies()).toEqual([`hello\n-# <@${TRIAGE}>`]);
    });
  });

  it("relays only the account's allowed inboxes", async () => {
    const world = new World();
    world.messages = [{ id: 1, content: "hello", message_type: 0 }];
    const accounts = (inboxIds: number[]) =>
      testSettings({ accounts: [{ id: 3, name: "Acme", forumChannelId: "100000000000000055", inboxIds }] });
    await withStore(async (store) => {
      await sync(store, accounts([9]));
      expect(world.posts()).toEqual([]);
      await sync(store, accounts([2, 9]));
      expect(world.replies()).toEqual([`hello\n-# <@${TRIAGE}>`]);
    });
  });

  it("after two reassignments in one run, pings the latest assignee once, after both activity lines", async () => {
    const world = new World();
    world.messages = [{ id: 1, content: "hello", message_type: 0, created_at: now() - 60 }];
    await withStore(async (store) => {
      const settings = testSettings();
      await sync(store, settings);
      world.conversation.meta = {
        ...Object(world.conversation.meta),
        // Linked by Chatwoot user id: an email changed in Chatwoot does not matter.
        assignee: { id: 43, name: "Bob", email: "robert@example.org" },
      };
      world.messages.push(
        { id: 2, content: "Assigned to Alice by Sam", message_type: 2, created_at: now() - 8 },
        { id: 3, content: "Assigned to Bob by Sam", message_type: 2, created_at: now() - 4 },
      );
      await sync(store, settings);
      const posted = world
        .posts()
        .slice(-3)
        .map((post) => [post.body.content, post.body.allowed_mentions]);
      expect(posted).toEqual([
        ["_Assigned to Alice by Sam_", { parse: [] }],
        ["_Assigned to Bob by Sam_", { parse: [] }],
        [`-# Assigned to <@${BOB}>`, { parse: [], users: [BOB] }],
      ]);
      // The new assignee is added to the post, once.
      expect(world.sent("PUT", `/thread-members/${BOB}`)).toHaveLength(1);
    });
  });

  it("retries a failed assignee announcement without new messages, so the assignee is still pinged", async () => {
    const world = new World();
    world.conversation.meta = { ...Object(world.conversation.meta), assignee: { id: 43, name: "Bob" } };
    world.messages = [{ id: 1, content: "hello", message_type: 0, created_at: now() - 5 }];
    world.failAnnouncements = 1;
    await withStore(async (store) => {
      const settings = testSettings();
      await expect(sync(store, settings)).rejects.toThrow();
      await sync(store, settings);
      // The customer message was posted once; the announcement failed, then its retry succeeded.
      expect(world.replies()).toEqual([
        `hello\n-# <@${TRIAGE}>`,
        `-# Assigned to <@${BOB}>`,
        `-# Assigned to <@${BOB}>`,
      ]);
      expect(world.posts().at(-1)?.body.allowed_mentions).toEqual({ parse: [], users: [BOB] });
      expect(store.conversation(3, 12)?.announcePending).toBe(0);
    });
  });

  it("relays an email reply without its quoted history, like Chatwoot does, and auto-replies without notifications", async () => {
    // As MailPresenter#serialized_data stores them at v4.18.0: `content` is the whole text.
    const history =
      "On Mon, Sep 21, 2026 at 10:02 AM Acme Support <support@acme.example> wrote:\n> Please restart the agent.\n> Kind regards";
    const email = (reply: string, extra: Record<string, unknown> = {}) => ({
      subject: "Re: Agent will not connect",
      from: ["jane@example.com"],
      multipart: true,
      auto_reply: false,
      text_content: { full: `${reply}\n\n${history}`, reply: `${reply}\n\n${history}`, quoted: reply },
      html_content: {
        full: `<div>${reply}</div><blockquote>Please restart the agent.</blockquote>`,
        reply: `${reply}\n\n> Please restart the agent.`,
        quoted: reply,
      },
      ...extra,
    });
    const world = new World();
    world.messages = [
      {
        id: 1,
        content: `Thanks, that worked!\n\n${history}`,
        message_type: 0,
        content_attributes: { email: email("Thanks, that worked!") },
      },
      // An HTML-only email has no text body: the HTML one, as text.
      {
        id: 2,
        content: "<div>Also this</div>",
        message_type: 0,
        content_attributes: { email: email("Also this", { text_content: {} }) },
      },
      {
        id: 3,
        content: `I am out of office until Monday.\n\n${history}`,
        message_type: 0,
        content_attributes: { email: email("I am out of office until Monday.", { auto_reply: true }) },
      },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      expect(world.replies()).toEqual([
        `Thanks, that worked!\n-# <@${TRIAGE}>`,
        `Also this\n-# <@${TRIAGE}>`,
        "I am out of office until Monday.",
      ]);
    });
  });

  it("shows what channels and bots send that is not plain text", async () => {
    const sticker = "https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker.png";
    const world = new World();
    world.messages = [
      // LINE stickers are stored as a markdown image.
      { id: 1, content: `![sticker-52002734](${sticker})`, content_type: "sticker", message_type: 0 },
      // A contact shared on Telegram.
      {
        id: 2,
        content: null,
        message_type: 0,
        attachments: [
          { file_type: "contact", fallback_title: "+15550100", meta: { first_name: "Ana", last_name: "Lima" } },
        ],
      },
      {
        id: 3,
        content: null,
        message_type: 0,
        attachments: [
          { file_type: "story_mention", data_url: "https://lookaside.example.com/story" },
          { file_type: "ig_reel", data_url: "https://lookaside.example.com/reel" },
          { file_type: "fallback", fallback_title: "Shared post", data_url: "https://example.com/p" },
        ],
      },
      {
        id: 4,
        content: "Pick a topic",
        content_type: "input_select",
        message_type: 1,
        content_attributes: {
          // An option without a title shows its value; a malformed field does not hide the rest.
          items: [
            { title: "Billing", value: "billing" },
            { title: "Technical", value: "tech" },
            { value: "other" },
            { title: 5, value: "five" },
          ],
        },
      },
      {
        id: 5,
        content: null,
        content_type: "cards",
        message_type: 1,
        content_attributes: {
          items: [
            {
              title: "Pro plan",
              description: "$10 a month",
              media_url: "https://example.com/pro.png",
              actions: [
                { type: "link", text: "Buy", uri: "https://example.com/buy" },
                { type: "postback", text: "More", payload: "more" },
              ],
            },
          ],
        },
      },
      {
        id: 6,
        content: null,
        content_type: "article",
        message_type: 1,
        content_attributes: {
          items: [{ title: "Reset your password", description: "Steps", link: "https://help.example.com/reset" }],
        },
      },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      expect(world.replies()).toEqual([
        `${sticker}\n-# <@${TRIAGE}>`,
        `📇 Ana Lima: +15550100\n-# <@${TRIAGE}>`,
        `📎 Story mention https://lookaside.example.com/story\n📎 Reel https://lookaside.example.com/reel\n📎 Shared post https://example.com/p\n-# <@${TRIAGE}>`,
        "Pick a topic\n• Billing\n• Technical\n• other\n• five",
        "• [Pro plan](<https://example.com/pro.png>) — $10 a month · [Buy](<https://example.com/buy>)",
        "• [Reset your password](<https://help.example.com/reset>) — Steps",
      ]);
    });
  });

  it("pings linked agents mentioned in private notes by their Chatwoot user id", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "[@Bob](mention://user/43/Bob) can you check?", message_type: 1, private: true },
      {
        id: 2,
        content: "[@Dana](mention://user/44/Dana) and [@Bob](mention://user/43/Bob)",
        message_type: 1,
        private: true,
      },
      { id: 3, content: "[@Bob](mention://user/43/Bob) in a reply", message_type: 1 },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      const posted = world
        .posts()
        .filter((post) => post.thread)
        .map((post) => [post.body.content, post.body.allowed_mentions]);
      expect(posted).toEqual([
        [`🔒 **Internal note**\n<@${BOB}> can you check?`, { parse: [], users: [BOB] }],
        // Dana is not linked to a Discord user.
        [`🔒 **Internal note**\n@Dana and <@${BOB}>`, { parse: [], users: [BOB] }],
        // Chatwoot notifies mentions in private notes only.
        ["@Bob in a reply", { parse: [] }],
      ]);
      expect(world.sent("GET", "/agents")).toEqual([]);
    });
  });
});

describe("agent avatars", () => {
  const cdn = "https://cdn.discordapp.com";
  const agent = (id: number, userId: number, thumbnail = "") => ({
    id,
    content: `reply ${id}`,
    message_type: 1,
    sender: { id: userId, type: "user", thumbnail },
  });

  function avatars(world: World): unknown[] {
    return world
      .posts()
      .filter((post) => post.thread)
      .map((post) => post.body.avatar_url);
  }

  it("shows linked agents' Discord avatars, looked up once a day, else their Chatwoot avatar", async () => {
    const world = new World();
    world.discordUsers = {
      [BOB]: { avatar: "a_bob", discriminator: "0" },
      [ALICE]: { avatar: null, discriminator: "0" },
    };
    world.messages = [
      agent(1, 43, "https://chatwoot.example.com/bob.png"),
      agent(2, 42),
      agent(3, 44, "https://chatwoot.example.com/dana.png"), // Dana is not linked.
      agent(4, 44),
      {
        id: 5,
        content: "bot reply",
        message_type: 1,
        sender: { id: 7, type: "agent_bot", thumbnail: "https://x.example/b.png" },
      },
      {
        id: 6,
        content: "customer",
        message_type: 0,
        sender: { id: 9, type: "contact", thumbnail: "https://x.example/c.png" },
      },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      world.messages.push(agent(7, 43));
      await sync(store, testSettings());
      expect(avatars(world)).toEqual([
        `${cdn}/avatars/${BOB}/a_bob.png`,
        `${cdn}/embed/avatars/${(BigInt(ALICE) >> 22n) % 6n}.png`,
        "https://chatwoot.example.com/dana.png",
        "https://chatwoot.example.com/favicon-512x512.png",
        "https://chatwoot.example.com/favicon-512x512.png",
        "https://x.example/c.png",
        `${cdn}/avatars/${BOB}/a_bob.png`,
      ]);
      // Cached: one lookup per agent.
      expect(world.sent("GET", `/users/${BOB}`)).toHaveLength(1);
      expect(world.sent("GET", `/users/${ALICE}`)).toHaveLength(1);
    });
  });

  it("falls back to the Chatwoot avatar when Discord will not say, without asking again for a while", async () => {
    const world = new World();
    world.messages = [agent(1, 43, "https://chatwoot.example.com/bob.png"), agent(2, 43)];
    await withStore(async (store) => {
      expect(await sync(store, testSettings())).toEqual(["done"]);
      expect(avatars(world)).toEqual([
        "https://chatwoot.example.com/bob.png",
        "https://chatwoot.example.com/favicon-512x512.png",
      ]);
      expect(world.sent("GET", `/users/${BOB}`)).toHaveLength(1);
    });
  });
});

describe("processMessageUpdate", () => {
  it("says once in the post when an agent's reply could not be delivered", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "hello", message_type: 0 },
      { id: 2, content: "Here is your refund", message_type: 1, status: "sent" },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      await sync(store, settings);
      // Delivery fails after the reply was relayed.
      Object.assign(world.messages[1] ?? {}, {
        status: "failed",
        content_attributes: { external_error: "Message outside the 24 hour window" },
      });
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      const notices = world.replies().filter((content) => content?.startsWith("⚠️"));
      expect(notices).toEqual(["⚠️ A reply could not be delivered to the customer: Message outside the 24 hour window"]);

      // A delivered message posts nothing.
      await processMessageUpdate(context(store, settings), 3, 12, 1);
      expect(world.replies().filter((content) => content?.startsWith("⚠️"))).toHaveLength(1);
    });
  });

  it("relays a failure and a response reported before their message was relayed, with the message", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "hello", message_type: 0 },
      { id: 2, content: "Here is your refund", message_type: 1, status: "failed", content_attributes: {} },
      {
        id: 3,
        content: "How did we do?",
        message_type: 3,
        content_type: "input_csat",
        content_attributes: { submitted_values: { csat_survey_response: { rating: 5 } } },
      },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      // The updates arrive first: there is no post yet, so the job relays them with the messages.
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      await processMessageUpdate(context(store, settings), 3, 12, 3);
      expect(world.posts()).toEqual([]);
      await sync(store, settings);
      expect(world.replies()).toEqual([
        `hello\n-# <@${TRIAGE}>`,
        "Here is your refund",
        "⚠️ A reply could not be delivered to the customer.",
        "How did we do?\n\n**CSAT:**\n• Rating: 5",
      ]);
    });
  });

  it("removes a deleted message with the response posted about it, and its text from the title", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "my password is hunter2", message_type: 0 },
      {
        id: 2,
        content: "How did we do?",
        message_type: 3,
        content_type: "input_csat",
        content_attributes: { submitted_values: { csat_survey_response: { rating: 1, feedback_message: "call me" } } },
      },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      await sync(store, settings);
      expect(world.replies()).toHaveLength(2); // the message and the response
      for (const message of world.messages) Object.assign(message, { content_attributes: { deleted: true } });
      await processMessageUpdate(context(store, settings), 3, 12, 1);
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      expect(world.sent("DELETE", "")).toHaveLength(2);
      const renamed = world
        .sent("PATCH", "")
        .map((request) => JSON.parse(request.body).name)
        .filter(Boolean);
      expect(renamed.at(-1)).toBe("[Acme #12] Jane Doe");
    });
  });
});
