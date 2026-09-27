// Shared fixtures and fakes. Outbound HTTP is mocked at the fetch boundary.

import { vi } from "vitest";
import { buildSettings, configSchema, type Settings, secretsSchema } from "../src/config.js";
import type { ForumClient, RelayStore, WebhookMessage } from "../src/relay/relay.js";
import { UnknownThreadError } from "../src/relay/relay.js";
import type { RelayMessage } from "../src/relay/types.js";

export const ALICE = "100000000000000011";
export const BOB = "100000000000000012";
export const CAROL = "100000000000000013"; // mapped to an email but has no token
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
    attachmentUrls: [],
    account: { id: 3, name: "Acme" },
    inboxName: "Acme — Product App",
    sender: { name: "Jane Doe", type: "contact" },
    ...rest,
    conversation: {
      id: 12,
      status: "open",
      channel: "Channel::WebWidget",
      contact: { name: "Jane Doe", email: "jane@example.com" },
      customAttributes: {},
      ...conversation,
    },
  };
}

export class MemoryStore implements RelayStore {
  threads = new Map<string, string>();
  states = new Map<string, string>();
  counters = new Map<string, number>();
  seen = new Set<string>();

  thread(a: number, c: number) {
    return this.threads.get(`${a}:${c}`);
  }
  saveThread(a: number, c: number, threadId: string) {
    this.threads.set(`${a}:${c}`, threadId);
  }
  state(a: number, c: number) {
    return this.states.get(`${a}:${c}`);
  }
  saveState(a: number, c: number, state: string) {
    this.states.set(`${a}:${c}`, state);
  }
  forgetThread(a: number, c: number) {
    this.threads.delete(`${a}:${c}`);
    this.states.delete(`${a}:${c}`);
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
  resolved: "t-resolved",
};

/** Records webhook executions like Discord would: a new post gets channel id "thread-<n>". */
export class FakeForum implements ForumClient {
  calls: Array<[string | undefined, WebhookMessage]> = [];
  patches: Array<[string, { applied_tags: string[]; archived: boolean }]> = [];
  failThreadWith: "gone" | "error" | undefined;

  constructor(
    public tags: Record<string, string> = TAGS,
    public guildId = "100000000000000044",
  ) {}

  async execute(_forum: string, payload: WebhookMessage, threadId?: string) {
    if (threadId && this.failThreadWith) {
      const failure = this.failThreadWith;
      this.failThreadWith = undefined;
      throw failure === "gone" ? new UnknownThreadError(threadId) : new Error("Discord HTTP 500");
    }
    this.calls.push([threadId, payload]);
    return { channelId: threadId ?? `thread-${this.calls.length}` };
  }

  async updatePost(threadId: string, patch: { applied_tags: string[]; archived: boolean }) {
    this.patches.push([threadId, patch]);
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
    discord: { applicationId: "100000000000000001" },
    accounts: [
      { id: 3, name: "Acme", forumChannelId: FORUM },
      { id: 1, name: "Globex", forumChannelId: FORUM },
    ],
    agents: [
      { discordUserId: ALICE, email: "Alice@example.com" },
      { discordUserId: BOB, email: "bob@example.com" },
      { discordUserId: CAROL, email: "carol@example.com" },
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
