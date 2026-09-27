import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordForum } from "../src/discord/forum.js";
import { DiscordHttpError, DiscordRest } from "../src/discord/rest.js";
import { UnknownThreadError } from "../src/relay/relay.js";
import { json, mockFetch, on } from "./helpers.js";

class MemoryCache {
  values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  delete(key: string) {
    this.values.delete(key);
  }
}

const api = "discord.com/api/v10";
const forumChannel = on("GET", `${api}/channels/55`, () =>
  json({
    id: "55",
    type: 15,
    guild_id: "44",
    available_tags: [
      { id: "t-acme", name: "Acme" },
      { id: "t-open", name: "open" },
      { id: "t-resolved", name: "Resolved" },
    ],
  }),
);

function forum() {
  return new DiscordForum(new DiscordRest("bot-token", (request) => fetch(request)), new MemoryCache());
}

afterEach(() => vi.restoreAllMocks());

describe("DiscordForum", () => {
  it("reuses the existing Chatwoot webhook and posts without the bot token", async () => {
    const { requests } = mockFetch(
      on("GET", `${api}/channels/55/webhooks`, () => json([{ id: "1", token: "abc", type: 1, name: "Chatwoot" }])),
      on("POST", `${api}/webhooks/1/abc`, () => json({ id: "m1", channel_id: "thread-9" })),
    );
    const client = forum();
    expect(await client.execute("55", { content: "hi", thread_name: "Ticket" })).toEqual({
      channelId: "thread-9",
      messageId: "m1",
    });
    await client.execute("55", { content: "again" }, "thread-9");
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(1); // webhook cached
    const posts = requests.filter((request) => request.url.pathname.startsWith("/api/v10/webhooks/"));
    expect(posts.map((request) => request.url.search)).toEqual(["?wait=true", "?wait=true&thread_id=thread-9"]);
    expect(posts.every((request) => request.headers.get("authorization") === null)).toBe(true);
    expect(requests[0]?.headers.get("authorization")).toBe("Bot bot-token");
  });

  it("creates the webhook when missing", async () => {
    const { requests } = mockFetch(
      on("GET", `${api}/channels/55/webhooks`, () => json([{ id: "2", token: "x", type: 1, name: "Someone else" }])),
      on("POST", `${api}/channels/55/webhooks`, () =>
        json({ id: "900", token: "new-token", type: 1, name: "Chatwoot" }),
      ),
      on("POST", `${api}/webhooks/900/new-token`, () => json({ id: "m1", channel_id: "thread-1" })),
    );
    await forum().execute("55", { content: "hi", thread_name: "Ticket" });
    expect(
      requests.find((request) => request.url.pathname === "/api/v10/channels/55/webhooks" && request.method === "POST")
        ?.body,
    ).toBe(JSON.stringify({ name: "Chatwoot" }));
  });

  it("matches tags by name, case-insensitively, skipping missing ones", async () => {
    mockFetch(forumChannel);
    const client = forum();
    expect(await client.tagIds("55", ["acme", "resolved"])).toEqual(["t-acme", "t-resolved"]);
    expect(await client.tagIds("55", ["Globex", "OPEN", undefined])).toEqual(["t-open"]);
    expect(await client.postUrl("55", "123")).toBe("https://discord.com/channels/44/123");
  });

  it("reports a deleted thread as UnknownThreadError", async () => {
    mockFetch(
      on("GET", `${api}/channels/55/webhooks`, () => json([{ id: "1", token: "abc", type: 1, name: "Chatwoot" }])),
      on("POST", `${api}/webhooks/1/abc`, () => json({ message: "Unknown Channel", code: 10003 }, { status: 404 })),
    );
    await expect(forum().execute("55", { content: "hi" }, "thread-1")).rejects.toBeInstanceOf(UnknownThreadError);
  });

  it("deletes a webhook message in its thread, treating an already deleted one as done", async () => {
    const { requests } = mockFetch(
      on("GET", `${api}/channels/55/webhooks`, () => json([{ id: "1", token: "abc", type: 1, name: "Chatwoot" }])),
      on("DELETE", `${api}/webhooks/1/abc/messages/m1`, () => new Response(null, { status: 204 })),
      on("DELETE", `${api}/webhooks/1/abc/messages/m2`, () =>
        json({ message: "Unknown Message", code: 10008 }, { status: 404 }),
      ),
    );
    const client = forum();
    await client.deleteMessage("55", "thread-1", "m1");
    await client.deleteMessage("55", "thread-1", "m2");
    const deletes = requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => request.url.search)).toEqual(["?thread_id=thread-1", "?thread_id=thread-1"]);
    expect(deletes.every((request) => request.headers.get("authorization") === null)).toBe(true);
  });

  it("checks that a thread still exists in the forum", async () => {
    mockFetch(
      on("GET", `${api}/channels/111`, () => json({ id: "111", type: 11, parent_id: "55" })),
      on("GET", `${api}/channels/222`, () => json({ id: "222", type: 11, parent_id: "99" })),
      on("GET", `${api}/channels/333`, () => json({ message: "Unknown Channel", code: 10003 }, { status: 404 })),
    );
    const client = forum();
    expect(await client.threadExists("55", "111")).toBe(true);
    expect(await client.threadExists("55", "222")).toBe(false);
    expect(await client.threadExists("55", "333")).toBe(false);
  });
});

describe("DiscordRest", () => {
  it("waits for retry_after on 429 and retries", async () => {
    let calls = 0;
    mockFetch(
      on("GET", `${api}/channels/1`, () => {
        calls += 1;
        return calls === 1
          ? json({ message: "You are being rate limited.", retry_after: 0.25, global: false }, { status: 429 })
          : json({ id: "1" });
      }),
    );
    const waits: number[] = [];
    const rest = new DiscordRest(
      "t",
      (request) => fetch(request),
      async (ms) => void waits.push(ms),
    );
    expect(await rest.get("/channels/1")).toEqual({ id: "1" });
    // The wait runs until the time Discord gave, measured from when the 429 arrived.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(200);
    expect(waits[0]).toBeLessThanOrEqual(250);
  });

  it("waits out an exhausted bucket before reusing the route", async () => {
    mockFetch(
      on("GET", `${api}/channels/1`, () =>
        json({ id: "1" }, { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1.5" } }),
      ),
    );
    const waits: number[] = [];
    const rest = new DiscordRest(
      "t",
      (request) => fetch(request),
      async (ms) => void waits.push(ms),
    );
    await rest.get("/channels/1");
    await rest.get("/channels/1");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(1000);
  });

  it("shares an exhausted bucket across routes that report it, per top-level resource", async () => {
    const limited = { "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2" };
    mockFetch(
      on(
        "DELETE",
        /^discord\.com\/api\/v10\/webhooks\/1\/abc\/messages\/\w+$/,
        () => new Response(null, { status: 204, headers: limited }),
      ),
      on(
        "DELETE",
        /^discord\.com\/api\/v10\/webhooks\/2\/xyz\/messages\/\w+$/,
        () => new Response(null, { status: 204 }),
      ),
    );
    const waits: number[] = [];
    const rest = new DiscordRest(
      "t",
      (request) => fetch(request),
      async (ms) => void waits.push(ms),
    );
    await rest.delete("/webhooks/1/abc/messages/m1");
    await rest.delete("/webhooks/1/abc/messages/m2"); // same bucket: waits
    await rest.delete("/webhooks/2/xyz/messages/m3"); // another webhook: does not
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(1000);
  });

  it("pauses every route after a global rate limit", async () => {
    let calls = 0;
    mockFetch(
      on("GET", `${api}/channels/1`, () => {
        calls += 1;
        return calls === 1
          ? json({ message: "You are being rate limited.", retry_after: 0.5, global: true }, { status: 429 })
          : json({ id: "1" });
      }),
      on("GET", `${api}/channels/2`, () => json({ id: "2" })),
    );
    const waits: number[] = [];
    const rest = new DiscordRest(
      "t",
      (request) => fetch(request),
      async (ms) => void waits.push(ms),
    );
    expect(await rest.get("/channels/1")).toEqual({ id: "1" });
    expect(waits).toHaveLength(1);
    // The test's sleep returns at once, so the global limit is still in force for another route.
    await rest.get("/channels/2");
    expect(waits).toHaveLength(2);
  });

  it("gives up on long rate limits and surfaces Discord's error code", async () => {
    mockFetch(
      on("GET", `${api}/channels/1`, () => json({ message: "slow down", retry_after: 60 }, { status: 429 })),
      on("GET", `${api}/channels/2`, () => json({ message: "Missing Access", code: 50001 }, { status: 403 })),
    );
    const rest = new DiscordRest(
      "t",
      (request) => fetch(request),
      async () => {},
    );
    await expect(rest.get("/channels/1")).rejects.toMatchObject({ status: 429 });
    const error = await rest.get("/channels/2").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscordHttpError);
    expect(error).toMatchObject({ status: 403, code: 50001 });
  });
});
