// Shared fixtures and fakes. Outbound HTTP is mocked at the fetch boundary.

import { vi } from "vitest";
import { buildSettings, configSchema, type Settings, secretsSchema } from "../src/config.ts";
import type { ForumClient, PostFields, RelayStore, WebhookMessage } from "../src/relay/relay.ts";
import { UnknownThreadError } from "../src/relay/relay.ts";
import type { RelayMessage } from "../src/relay/types.ts";

export const ALICE = "100000000000000011";
export const BOB = "100000000000000012";
export const CAROL = "100000000000000013"; // linked but has no token
export const TRIAGE = "100000000000000777";
export const FORUM = "100000000000000055";

type Overrides = Omit<Partial<RelayMessage>, "conversation"> & { conversation?: Partial<RelayMessage["conversation"]> };

export function message(overrides: Overrides = {}): RelayMessage {
  const { conversation, ...rest } = overrides;
  return {
    id: 101,
    messageType: "incoming",
    private: false,
    content: "My agent will not connect",
    attachments: [],
    account: { id: 3, name: "Acme" },
    inboxName: "Acme — Product App",
    sender: { name: "Jane Doe", type: "contact" },
    ...rest,
    conversation: {
      id: 12,
      status: "open",
      channel: "Channel::WebWidget",
      contact: { name: "Jane Doe", email: "jane@example.com" },
      labels: [],
      customAttributes: {},
      ...conversation,
    },
  };
}

export class MemoryStore implements RelayStore {
  rows = new Map<string, Partial<PostFields>>();
  parts = new Map<string, string[]>();
  counters = new Map<string, number>();
  seen = new Set<string>();

  conversation(a: number, c: number) {
    const row = this.rows.get(`${a}:${c}`);
    if (!row) return undefined;
    const { threadId, state, announcedAssignee, titleSubject, title } = row;
    return { threadId, state, announcedAssignee, titleSubject, title };
  }
  updateConversation(a: number, c: number, patch: Partial<PostFields>) {
    this.rows.set(`${a}:${c}`, { ...this.rows.get(`${a}:${c}`), ...patch });
  }
  thread(a: number, c: number) {
    return this.rows.get(`${a}:${c}`)?.threadId;
  }
  postedParts(a: number, c: number, messageId: number) {
    return this.parts.get(`${a}:${c}:${messageId}`) ?? [];
  }
  savePostedPart(a: number, c: number, messageId: number, part: number, discordId: string) {
    const parts = this.postedParts(a, c, messageId);
    parts[part] = discordId;
    this.parts.set(`${a}:${c}:${messageId}`, parts);
  }
  forgetThread(a: number, c: number) {
    this.rows.delete(`${a}:${c}`);
    for (const key of this.parts.keys()) if (key.startsWith(`${a}:${c}:`)) this.parts.delete(key);
  }
  firstAttempt(name: string) {
    if (this.seen.has(name)) return false;
    this.seen.add(name);
    return true;
  }
  increment(name: string) {
    const count = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, count);
    return count;
  }
}

export const TAGS: Record<string, string> = {
  acme: "t-acme",
  globex: "t-globex",
  open: "t-open",
  pending: "t-pending",
  resolved: "t-resolved",
};

type ThreadPatch = { archived: boolean; applied_tags?: string[]; name?: string };

/**
 * Records webhook executions like Discord would: a new post gets channel id "thread-<n>" and
 * every message id "message-<n>". Like Discord, posting into an archived post unarchives it, and
 * an archived post's tags cannot change unless the same update unarchives it.
 */
export class FakeForum implements ForumClient {
  calls: Array<[string | undefined, WebhookMessage]> = [];
  patches: Array<[string, ThreadPatch]> = [];
  deleted: string[] = [];
  archived = new Set<string>();
  failThreadWith: "gone" | "error" | undefined;
  /** Fails the next execution into a thread after this many succeed. */
  failAfter: number | undefined;

  constructor(
    public tags: Record<string, string> = TAGS,
    public guildId = "100000000000000044",
  ) {}

  async execute(_forum: string, payload: WebhookMessage, threadId?: string) {
    if (threadId && this.failAfter !== undefined) {
      if (this.failAfter === 0) {
        this.failAfter = undefined;
        throw new Error("Discord HTTP 500");
      }
      this.failAfter -= 1;
    }
    if (threadId && this.failThreadWith) {
      const failure = this.failThreadWith;
      this.failThreadWith = undefined;
      throw failure === "gone" ? new UnknownThreadError(threadId) : new Error("Discord HTTP 500");
    }
    this.calls.push([threadId, payload]);
    if (threadId) this.archived.delete(threadId);
    return { channelId: threadId ?? `thread-${this.calls.length}`, messageId: `message-${this.calls.length}` };
  }

  async updateThread(_forum: string, threadId: string, patch: ThreadPatch) {
    if (this.failThreadWith === "gone") {
      this.failThreadWith = undefined;
      throw new UnknownThreadError(threadId);
    }
    if (this.archived.has(threadId) && patch.archived !== false) {
      throw new Error("Discord HTTP 400: Thread is archived");
    }
    this.patches.push([threadId, patch]);
    if (patch.archived) this.archived.add(threadId);
    else this.archived.delete(threadId);
  }

  async deleteMessage(_forum: string, _threadId: string, messageId: string) {
    this.deleted.push(messageId);
  }

  async tagIds(_forum: string, names: ReadonlyArray<string | undefined>) {
    const ids = names.flatMap((name) => {
      const id = name === undefined ? undefined : this.tags[name.toLowerCase()];
      return id ? [id] : [];
    });
    return [...new Set(ids)].slice(0, 5);
  }

  async threadExists() {
    return true;
  }

  async postUrl(_forum: string, threadId: string) {
    return `https://discord.com/channels/${this.guildId}/${threadId}`;
  }

  contents(): string[] {
    return this.calls.map(([, payload]) => payload.content ?? "");
  }
}

export function testSettings(overrides: Record<string, unknown> = {}): Settings {
  const config = configSchema.parse({
    chatwoot: { baseUrl: "https://chatwoot.example.com" },
    accounts: [
      { id: 3, name: "Acme", forumChannelId: FORUM },
      { id: 1, name: "Globex", forumChannelId: FORUM },
    ],
    agents: [
      { discordUserId: ALICE, chatwootUserId: 42 },
      { discordUserId: BOB, chatwootUserId: 43 },
      { discordUserId: CAROL, chatwootUserId: 45 },
    ],
    triage: { userId: TRIAGE, draftLabels: ["Draft"] },
    ...overrides,
  });
  const secrets = secretsSchema.parse({
    DISCORD_BOT_TOKEN: "bot",
    DISCORD_PUBLIC_KEY: "0".repeat(64),
    CHATWOOT_RELAY_TOKEN: "relay-token",
    CHATWOOT_WEBHOOK_SECRETS: JSON.stringify({ "3": "secret-acme" }),
    CHATWOOT_AGENT_TOKENS: JSON.stringify({ [ALICE]: "token-alice", [BOB]: "token-bob" }),
  });
  return buildSettings(config, secrets);
}

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  form: FormData | undefined;
}

export type Route = (request: Recorded) => Response | Promise<Response> | undefined;

/**
 * Replaces global fetch with a router. Unmatched requests fail the test loudly instead of
 * reaching the network.
 */
export function mockFetch(...routes: Route[]) {
  const requests: Recorded[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const type = request.headers.get("content-type") ?? "";
    const form = type.startsWith("multipart/form-data") ? await request.clone().formData() : undefined;
    const recorded: Recorded = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: form ? "" : await request.text(),
      form,
    };
    requests.push(recorded);
    for (const route of routes) {
      const response = await route(recorded);
      if (response) return response;
    }
    return new Response(JSON.stringify({ message: `unmocked ${request.method} ${request.url}` }), { status: 599 });
  });
  return { requests, spy };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function on(method: string, path: string | RegExp, respond: (request: Recorded) => Response): Route {
  return (request) => {
    const target = `${request.url.hostname}${request.url.pathname}`;
    const matches = typeof path === "string" ? target === path : path.test(target);
    return request.method === method && matches ? respond(request) : undefined;
  };
}
