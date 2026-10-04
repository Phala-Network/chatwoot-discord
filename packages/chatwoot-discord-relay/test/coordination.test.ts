import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { QueueStore } from "../../../shared/store.ts";
import { configSchema } from "../src/config.ts";
import { control } from "../src/control.ts";
import { QueueDigest } from "../src/digest.ts";
import { DiscordLimiter, fingerprint, type LimitReport, LimitState, type Reservation } from "../src/discord/limiter.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { ForumRegistry } from "../src/registry.ts";
import { AccountSweep } from "../src/sweep.ts";
import { json, mockFetch, on } from "./helpers.ts";

class Memory {
  private readonly rows = new Map<string, string>();
  get<T>(key: string): T | undefined {
    const row = this.rows.get(key);
    return row === undefined ? undefined : JSON.parse(row);
  }
  set(key: string, value: unknown) {
    this.rows.set(key, JSON.stringify(value));
  }
  delete(key: string) {
    this.rows.delete(key);
  }
}
const request = (credential = "alice", route = "POST:messages", global = false): Reservation => ({
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  credential,
  route,
  global,
});
const report = (reservation: Reservation, fields: Partial<LimitReport> = {}): LimitReport => ({
  owner: "channel:1",
  reservation,
  bucket: "bucket",
  remaining: 1,
  capacity: 2,
  resetAfterMs: 1000,
  retryAfterMs: 0,
  global: false,
  ...fields,
});
afterEach(() => vi.restoreAllMocks());

it("creates a fresh resource after definitive deletion of its confirmed webhook without replaying the old receipt", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let created = 0;
  mockFetch(
    on("GET", "discord.com/api/v10/applications/@me", () => json({ id: "100000000000000001" })),
    on("GET", "discord.com/api/v10/channels/55", () => json({ id: "55", guild_id: "44" })),
    on("GET", "discord.com/api/v10/channels/55/webhooks", () => json([])),
    on("POST", "discord.com/api/v10/channels/55/webhooks", () =>
      json({ id: String(100 + ++created), token: "fixture", type: 1, application_id: "100000000000000001" }),
    ),
  );
  await runInDurableObject(
    env.FORUM_REGISTRY.getByName(`recreate:${crypto.randomUUID()}`),
    async (_instance, state) => {
      vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
      let registry = new ForumRegistry(state, env);
      expect(await registry.lookup("55")).toBeNull();
      for (let alarm = 0; alarm < 5 && !(await registry.lookup("55")); alarm++) {
        state.storage.sql.exec("UPDATE jobs SET not_before=0");
        await registry.alarm();
        now += 1101;
      }
      const first = await registry.lookup("55");
      expect(first?.id).toBe("101");
      if (!first) throw new Error("Missing fixture webhook");
      await registry.invalidate("55", first.version);
      now += 60000;
      registry = new ForumRegistry(state, env);
      for (let alarm = 0; alarm < 5 && !(await registry.lookup("55")); alarm++) {
        state.storage.sql.exec("UPDATE jobs SET not_before=0");
        await registry.alarm();
        now += 1101;
      }
      const next = await registry.lookup("55");
      expect(next?.id).toBe("102");
      if (!next) throw new Error("Missing recreated fixture webhook");
      await registry.invalidate("55", first.version);
      expect(await registry.lookup("55")).toEqual(next);
      expect(created).toBe(2);
    },
  );
});

it("claims one immutable thread owner and rejects tombstoned interactions without upstream I/O", async () => {
  const owner = { accountId: 3, conversationId: 1, guildId: "1", forumId: "2", generation: 1 };
  const directory = env.THREAD_DIRECTORY.getByName(`test:${crypto.randomUUID()}`);
  const network = vi.spyOn(globalThis, "fetch");
  const grants = await Promise.all([directory.claim(owner), directory.claim({ ...owner, conversationId: 2 })]);
  expect(grants).toEqual([true, false]);
  expect(await directory.claim(owner)).toBe(true);
  const reordered = {
    generation: owner.generation,
    forumId: owner.forumId,
    guildId: owner.guildId,
    conversationId: owner.conversationId,
    accountId: owner.accountId,
  };
  expect(await directory.claim(reordered)).toBe(true);
  expect(await directory.tombstone(reordered)).toBe(true);
  expect(await directory.get()).toBeNull();
  expect(await directory.claim(owner)).toBe(false);
  expect(network).not.toHaveBeenCalled();
});

it("reserves the last triage slot once, including lost receipt/repeated request and expired hour", async () => {
  const quota = env.TRIAGE_BUDGET.getByName(`test:${crypto.randomUUID()}`);
  const hour = new Date().toISOString().slice(0, 13);
  expect(await Promise.all([quota.reserve(hour, "a", 1), quota.reserve(hour, "b", 1)])).toEqual([true, false]);
  expect(await quota.reserve(hour, "a", 1)).toBe(true);
  expect(await quota.reserve("2000-01-01T00", "a", 1)).toBe(false);
});

it("limits user buckets by credential, shared buckets across credentials, and isolates majors", () => {
  const limits = new LimitState(new Memory());
  const a = request();
  expect(limits.reserve(a).allowed).toBe(true);
  limits.report(report(a, { remaining: 0, scope: "user" }));
  expect(limits.reserve(request()).allowed).toBe(false);
  expect(limits.reserve(request("bob")).allowed).toBe(true);
  const shared = new LimitState(new Memory());
  const s = request();
  shared.reserve(s);
  shared.report(report(s, { remaining: 0, scope: "shared" }));
  expect(shared.reserve(request("bob")).allowed).toBe(false);
  expect(new LimitState(new Memory()).reserve(request()).allowed).toBe(true);
});

it("learns capacity, never tops up on repeated/out-of-order reports, and rejects expired permits", () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const limits = new LimitState(new Memory());
  const a = request();
  limits.reserve(a);
  limits.report(report(a, { remaining: 0 }));
  limits.report(report(a, { remaining: 200 }));
  expect(limits.reserve(request()).allowed).toBe(false);
  now += 1101;
  expect(limits.reserve(request()).allowed).toBe(true);
  expect(limits.reserve(request()).allowed).toBe(true);
  expect(limits.reserve(request()).allowed).toBe(false);
  expect(limits.reserve(a).allowed).toBe(false);
  now += 61_000;
  expect(limits.reserve(a).allowed).toBe(false);
});

it("does not refill a learned sixty-second bucket every second without another response", () => {
  let now = 100000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const state = new Memory();
  let limits = new LimitState(state);
  const probe = request("test");
  expect(limits.reserve(probe).allowed).toBe(true);
  limits.report(report(probe, { bucket: "slow-bucket", remaining: 0, capacity: 2, resetAfterMs: 60000 }));
  now += 60001;
  expect(limits.reserve(request("test")).allowed).toBe(true);
  expect(limits.reserve(request("test")).allowed).toBe(true);
  expect(limits.reserve(request("test")).allowed).toBe(false);
  now += 1001;
  limits = new LimitState(state);
  const next = limits.reserve(request("test"));
  expect(next.allowed).toBe(false);
  if (!next.allowed) expect(next.retryAfterMs).toBeGreaterThan(58000);
});

it("delivers feedback independently of unrelated pending reports while fencing that domain until its cooldown arrives", async () => {
  const rows = new Map<string, string>();
  const store = { get: (key: string) => rows.get(key), set: (key: string, value: string) => rows.set(key, value) };
  const pending = report(request(await fingerprint("test"), "GET:/channels/:major/messages"), {
    owner: "channels:unrelated",
    scope: "shared",
    retryAfterMs: 60000,
  });
  store.set("discord:reports", JSON.stringify([pending]));
  const limits = new Map<string, LimitState>();
  const reservations: string[] = [];
  let unavailable = true;
  const limiter = new DiscordLimiter(store, {
    DISCORD_RATE_LIMIT: {
      getByName(name) {
        let state = limits.get(name);
        if (!state) {
          state = new LimitState(new Memory());
          limits.set(name, state);
        }
        const owner = state;
        return {
          async reserve(value) {
            reservations.push(name);
            return owner.reserve(value);
          },
          async report(value) {
            if (name === pending.owner && unavailable) throw new Error("control unavailable");
            owner.report(value);
          },
        };
      },
    },
  });
  expect((await limiter.reserve("PATCH", "/webhooks/app/token/messages/@original", "test", false, true)).allowed).toBe(
    true,
  );
  expect(reservations).toEqual(["webhooks:app"]);
  expect(JSON.parse(store.get("discord:reports") ?? "[]")).toEqual([pending]);
  await expect(limiter.reserve("GET", "/channels/unrelated/messages", "test", true, false)).rejects.toThrow();
  expect(reservations).toEqual(["webhooks:app"]);
  unavailable = false;
  expect((await limiter.reserve("GET", "/channels/unrelated/messages", "test", true, false)).allowed).toBe(false);
  expect(reservations).toEqual(["webhooks:app", "channels:unrelated"]);
  expect(JSON.parse(store.get("discord:reports") ?? "[]")).toEqual([]);
});

it("keeps the longest shared cooldown after duplicate reports and owner restart", async () => {
  const owner = env.DISCORD_RATE_LIMIT.getByName(`test:${crypto.randomUUID()}`);
  const a = request();
  await owner.reserve(a);
  await owner.report(report(a, { retryAfterMs: 60_000, scope: "shared" }));
  await owner.report(report(a, { retryAfterMs: 1, remaining: 100 }));
  const b = await owner.reserve(request("bob"));
  expect(b.allowed).toBe(false);
  if (!b.allowed) expect(b.retryAfterMs).toBeGreaterThan(59_000);
  await runInDurableObject(owner, (_instance, state) =>
    expect(state.storage.sql.exec("SELECT 1 FROM state").toArray().length).toBeGreaterThan(0),
  );
});

it("yields expired dispatch permits without HTTP, then obeys warm capacity and real cooldowns on a fresh reservation", async () => {
  let now = Date.now();
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  let expire = false;
  let cooldown = false;
  const limits = new Map<string, LimitState>();
  const rows = new Map<string, string>();
  const limiter = new DiscordLimiter(
    { get: (key) => rows.get(key), set: (key, value) => rows.set(key, value) },
    {
      DISCORD_RATE_LIMIT: {
        getByName(name) {
          let state = limits.get(name);
          if (!state) {
            state = new LimitState(new Memory());
            limits.set(name, state);
          }
          const owner = state;
          return {
            async reserve(value) {
              const permit = owner.reserve(value);
              if (expire && permit.allowed) {
                now += 101;
                elapsed += 101;
              }
              return permit;
            },
            async report(value) {
              owner.report(value);
            },
          };
        },
      },
    },
  );
  const { requests } = mockFetch(
    on("PATCH", "discord.com/api/v10/webhooks/app/fixture/messages/@original", () =>
      cooldown ? json({ retry_after: 60 }, { status: 429 }) : json({}),
    ),
  );
  const rest = new DiscordRest("fixture", fetch, limiter);
  const patch = () =>
    rest.patch("/webhooks/app/fixture/messages/@original", { body: {}, auth: false, interaction: true });
  await patch(); // Real warm-up/report path.
  expire = true;
  await expect(patch()).rejects.toMatchObject({ status: 429, retryAfterMs: 100 });
  expect(requests).toHaveLength(1); // Expired permit did not dispatch.
  expire = false;
  now += 100;
  elapsed += 100;
  await patch();
  expect(requests).toHaveLength(2);
  cooldown = true;
  await expect(patch()).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
  now += 100;
  elapsed += 100;
  await expect(patch()).rejects.toMatchObject({ status: 429, retryAfterMs: 59900 });
  expect(requests).toHaveLength(3); // Actual cooldown still fences HTTP.
  expire = true;
  await expect(
    limiter.reserve("PATCH", "/webhooks/cold/fixture/messages/@original", "fixture", false, true),
  ).resolves.toEqual({ allowed: false, retryAfterMs: 100 });
  expire = false;
  now += 100;
  elapsed += 100;
  const cold = await limiter.reserve("PATCH", "/webhooks/cold/fixture/messages/@original", "fixture", false, true);
  expect(cold.allowed).toBe(false);
  if (!cold.allowed) expect(cold.retryAfterMs).toBe(799); // Undispatched cold probe was still consumed.
});

it("does not lose a shared cooldown when a concurrent successful response omits scope", () => {
  const limits = new LimitState(new Memory());
  const a = request();
  const b = request("bob");
  limits.reserve(a);
  limits.reserve(b);
  limits.report(report(a, { retryAfterMs: 60000, scope: "shared" }));
  limits.report(report(b, { remaining: 100 }));
  const retry = limits.reserve(request("carol"));
  expect(retry.allowed).toBe(false);
  if (!retry.allowed) expect(retry.retryAfterMs).toBeGreaterThan(59000);
});

it("counts global permits across the sliding window and bounds a control wait by its job slice", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const limits = new LimitState(new Memory());
  for (let i = 0; i < 50; i++) expect(limits.reserve(request("bot", "global", true)).allowed).toBe(true);
  expect(limits.reserve(request("bot", "global", true)).allowed).toBe(false);
  now += 1000;
  expect(limits.reserve(request("bot", "global", true)).allowed).toBe(false);
  now += 101;
  expect(limits.reserve(request("bot", "global", true)).allowed).toBe(true);
  const budget = new Budget(2);
  budget.startSlice(10);
  await expect(control(budget, () => new Promise<never>(() => {}))).rejects.toThrow();
  expect(budget.remaining).toBe(1);
});

it("keeps scans, full requests and healthy deliveries moving behind a failed batch and recovers it", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const failed = Array.from({ length: 15 }, (_, index) => 101 + index);
  const delivered: number[] = [];
  const pages: number[] = [];
  let unavailable = true;
  let pageUnavailable = true;
  let laterScan = false;
  mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", (request) => {
      const page = Number(request.url.searchParams.get("page"));
      pages.push(page);
      if (page === 2 && pageUnavailable) return json({}, { status: 503 });
      return json({
        data: {
          payload: (page === 1 ? [...failed, 199] : page === 2 ? [laterScan ? 499 : 299] : page === 3 ? [399] : []).map(
            (id) => ({
              id,
              inbox_id: 2,
              messages: [{ id }],
              last_activity_at: id === 399 ? 1 : now / 1000,
            }),
          ),
        },
      });
    }),
  );
  const namespace = new Proxy(env.CONVERSATION, {
    get(target, key, receiver) {
      if (key === "getByName")
        return () => ({
          enqueueConversation: async (_account: number, id: number) => {
            if (unavailable && failed.includes(id)) {
              if (id === 101) await new Promise<never>(() => {});
              throw new Error("Child unavailable");
            }
            delivered.push(id);
          },
        });
      return Reflect.get(target, key, receiver);
    },
  });
  await runInDurableObject(
    env.ACCOUNT_SWEEP.getByName(`delivery-isolation:${crypto.randomUUID()}`),
    async (_instance, state) => {
      vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
      const bindings = { ...env, CONVERSATION: namespace };
      let executor = new AccountSweep(state, bindings);
      await executor.request(3);
      for (let alarm = 0; alarm < 3; alarm++) {
        await executor.alarm();
        now++;
        executor = new AccountSweep(state, bindings);
      }
      expect(delivered).toContain(199);
      expect(delivered).not.toContain(399);
      // A full request restarts page one despite both page-read and child retry backlogs.
      pageUnavailable = false;
      await executor.request(3, true);
      for (let alarm = 0; alarm < 8; alarm++) await executor.alarm();
      expect(pages.filter((page) => page === 1)).toHaveLength(2);
      expect(pages).toContain(3);
      expect(pages).toContain(4);
      expect(delivered).toContain(299);
      expect(delivered).toContain(399);
      expect(delivered.some((id) => failed.includes(id))).toBe(false);

      laterScan = true;
      await executor.request(3);
      for (let alarm = 0; alarm < 8; alarm++) await executor.alarm();
      expect(pages.filter((page) => page === 1)).toHaveLength(3);
      expect(delivered).toContain(499);
      unavailable = false;
      now += 30 * 60 * 1000 + 1;
      executor = new AccountSweep(state, bindings);
      for (let alarm = 0; alarm < 3; alarm++) await executor.alarm();
      for (const id of failed) expect(delivered.filter((sent) => sent === id)).toHaveLength(1);
    },
  );
});

it.each([false, true])(
  "restarts a full sweep at page one despite a saved window and an in-flight old read (%s)",
  async (inFlight) => {
    let release = () => {};
    let began = () => {};
    const reading = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pages: number[] = [];
    const delivered: number[] = [];
    const { requests } = mockFetch(
      on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", async (request) => {
        const page = Number(request.url.searchParams.get("page"));
        pages.push(page);
        if (page === 7) {
          began();
          await gate;
        }
        return json({
          data: { payload: page === 1 ? [{ id: 98781, inbox_id: 2, messages: [{ id: 1 }], last_activity_at: 1 }] : [] },
        });
      }),
    );
    const namespace = new Proxy(env.CONVERSATION, {
      get(target, property, receiver) {
        if (property === "getByName")
          return () => ({
            enqueueConversation: async (_account: number, id: number) => {
              delivered.push(id);
            },
          });
        return Reflect.get(target, property, receiver);
      },
    });
    await runInDurableObject(
      env.ACCOUNT_SWEEP.getByName(`full-race:${crypto.randomUUID()}`),
      async (_instance, state) => {
        vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
        const store = new QueueStore(state.storage.sql);
        let executor = new AccountSweep(state, { ...env, CONVERSATION: namespace });
        await executor.request(3);
        store.set(
          "scan",
          JSON.stringify({ page: 7, cutoff: Date.now() / 1000 - 60, done: false, startedAt: Date.now() }),
        );
        const old = inFlight ? executor.alarm() : undefined;
        if (inFlight) await reading;
        await executor.request(3, true);
        release();
        await old;
        for (let alarm = 0; alarm < 5 && store.nextWakeup() !== undefined; alarm++) {
          state.storage.sql.exec("UPDATE jobs SET not_before=0");
          executor = new AccountSweep(state, { ...env, CONVERSATION: namespace });
          await executor.alarm();
        }
        expect(delivered).toContain(98781);
        expect(pages.slice(inFlight ? 1 : 0)).toEqual([1, 2]);
        expect(store.nextWakeup()).toBeUndefined();
      },
    );
    expect(requests.length).toBe(inFlight ? 3 : 2);
  },
);

it("keeps the account sweep asleep for Chatwoot's full Retry-After instead of polling the cooldown", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let reads = 0;
  mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", () => {
      reads++;
      return json({}, { status: 429, headers: { "retry-after": "63" } });
    }),
  );
  await runInDurableObject(
    env.ACCOUNT_SWEEP.getByName(`sweep-cooldown:${crypto.randomUUID()}`),
    async (_instance, state) => {
      vi.spyOn(state.storage, "getAlarm").mockResolvedValue(null);
      const wake = vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
      const executor = new AccountSweep(state, env);
      await executor.request(3);
      await executor.alarm();
      expect(Number(wake.mock.calls.at(-1)?.[0]) - now).toBeGreaterThanOrEqual(63000);
      now += 5001;
      await executor.alarm();
      expect(reads).toBe(1);
    },
  );
});

it("keeps the hourly digest asleep for Chatwoot's full Retry-After", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", () =>
      json({}, { status: 429, headers: { "retry-after": "63" } }),
    ),
  );
  await runInDurableObject(
    env.QUEUE_DIGEST.getByName(`digest-cooldown:${crypto.randomUUID()}`),
    async (_instance, state) => {
      vi.spyOn(state.storage, "getAlarm").mockResolvedValue(null);
      const wake = vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
      const executor = new QueueDigest(state, {
        ...env,
        CONFIG: { ...configSchema.parse(env.CONFIG), queue: { channelId: "100000000000000099" } },
      });
      await executor.request(now);
      await executor.alarm();
      expect(Number(wake.mock.calls.at(-1)?.[0]) - now).toBeGreaterThanOrEqual(63000);
    },
  );
});
