import { afterEach, describe, expect, it, vi } from "vitest";
import { chatwootClient } from "../src/chatwoot/api.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { escalationLevel, postQueue, type QueueStore } from "../src/queue.ts";
import { ALICE, json, mockFetch, on, type Recorded, testSettings } from "./helpers.ts";

const CHANNEL = "100000000000000900";
const ROLE = "100000000000000901";
const HOUR = 3600;
const NOW = 1_800_000_000; // seconds

class MapStore implements QueueStore {
  values = new Map<string, string>();
  threads = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  conversation(accountId: number, conversationId: number) {
    const threadId = this.threads.get(`${accountId}:${conversationId}`);
    return threadId ? { threadId } : undefined;
  }
}

interface Open {
  id: number;
  waiting?: number; // hours
  assignee?: { id: number; name: string };
}

/** Open conversations of account 3 (25 per page, like Chatwoot), none in account 1, and Discord. */
function world(open: Open[], { failPost = 0 } = {}) {
  let failures = failPost;
  let posts = 0;
  return mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", (request) => {
      const page = Number(request.url.searchParams.get("page"));
      const payload = open.slice((page - 1) * 25, page * 25).map((c) => ({
        id: c.id,
        inbox_id: 2,
        status: "open",
        waiting_since: c.waiting === undefined ? 0 : NOW - c.waiting * HOUR,
        meta: { assignee: c.assignee ?? null },
      }));
      return json({ data: { meta: {}, payload } });
    }),
    on("GET", "chatwoot.example.com/api/v1/accounts/1/conversations", () => json({ data: { meta: {}, payload: [] } })),
    on("POST", `discord.com/api/v10/channels/${CHANNEL}/messages`, () => {
      posts += 1;
      if (posts > 1 && failures > 0) {
        failures -= 1;
        return json({ message: "Internal Server Error" }, { status: 500 });
      }
      return json({ id: `m-${posts}` });
    }),
  );
}

function context(store = new MapStore()) {
  const settings = testSettings({ queue: { channelId: CHANNEL, escalationRoleId: ROLE } });
  const fetch = (request: Request) => globalThis.fetch(request);
  return {
    settings,
    store,
    chatwoot: chatwootClient(settings.config.chatwoot.baseUrl, "relay-token", fetch),
    rest: new DiscordRest("bot", fetch, async () => {}),
  };
}

const posted = (requests: Recorded[]) =>
  requests
    .filter((request) => request.method === "POST" && request.url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
    .map((request) => JSON.parse(request.body));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("support queue", () => {
  it("lists waiting and unassigned tickets, longest wait first, and allows only linked assignees and the escalation", async () => {
    const store = new MapStore();
    store.threads.set("3:1", "100000000000000777");
    const { requests } = world([
      { id: 1, waiting: 3 },
      { id: 2, waiting: 0.25, assignee: { id: 42, name: "Alice" } },
      { id: 3, assignee: { id: 43, name: "Bob" } },
      { id: 4 },
      { id: 5, waiting: 1, assignee: { id: 99, name: `<@&${ROLE}> Mallory` } },
    ]);

    await postQueue(context(store), NOW * 1000);

    const [message] = posted(requests);
    expect(message.content.split("\n")).toEqual([
      `📋 Support queue <t:${NOW}:t>`,
      `<@&${ROLE}> 🔔 tickets have waited with no assignee: please \`/assign\` one.`,
      "🔔 <#100000000000000777> | waiting 3 h | ❔ Unassigned",
      `[Acme #5](<https://chatwoot.example.com/app/accounts/3/conversations/5>) | waiting 1 h | <​@&${ROLE}> Mallory`,
      `[Acme #2](<https://chatwoot.example.com/app/accounts/3/conversations/2>) | waiting 15 min | <@${ALICE}>`,
      "[Acme #4](<https://chatwoot.example.com/app/accounts/3/conversations/4>) | replied | ❔ Unassigned",
    ]);
    expect(message.allowed_mentions).toEqual({ parse: [], users: [ALICE], roles: [ROLE] });
  });

  it("escalates an unassigned ticket once per step of its wait", async () => {
    const store = new MapStore();
    const hours = [3, 3.5, 4];
    const { requests } = world([{ id: 1, waiting: 3 }]);

    for (const [index, elapsed] of hours.entries()) {
      await postQueue(context(store), (NOW + (elapsed - 3) * HOUR) * 1000);
      expect(posted(requests)[index].allowed_mentions.roles).toEqual(elapsed === 3.5 ? [] : [ROLE]);
    }
    expect(escalationLevel(0.5)).toBe(0);
    expect(escalationLevel(16)).toBe(5);
    expect(escalationLevel(40)).toBe(6);
  });

  it("posts nothing when the queue is empty", async () => {
    const { requests } = world([{ id: 3, assignee: { id: 43, name: "Bob" } }]);

    await postQueue(context(), NOW * 1000);

    expect(posted(requests)).toEqual([]);
  });

  it("splits a long queue, notes what it could not read, and does not ping again when a later part is retried", async () => {
    const store = new MapStore();
    const open = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, waiting: 2 }));
    const { requests } = world(open, { failPost: 1 });

    await expect(postQueue(context(store), NOW * 1000)).rejects.toThrow();
    await postQueue(context(store), NOW * 1000);

    const messages = posted(requests);
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.every((message) => message.content.length <= 2000)).toBe(true);
    expect(messages.at(-1).content).toMatch(/…and (\d+ )?more: see Chatwoot\.$/);
    expect(messages.filter((message) => message.allowed_mentions.roles.length > 0)).toHaveLength(1);
  });
});
