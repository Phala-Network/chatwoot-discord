import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { control } from "../src/control.ts";
import { type LimitReport, LimitState, type Reservation } from "../src/discord/limiter.ts";

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

it("claims one immutable thread owner and rejects tombstoned interactions without upstream I/O", async () => {
  const owner = { accountId: 3, conversationId: 1, guildId: "1", forumId: "2", generation: 1 };
  const directory = env.THREAD_DIRECTORY.getByName(`test:${crypto.randomUUID()}`);
  const network = vi.spyOn(globalThis, "fetch");
  const grants = await Promise.all([directory.claim(owner), directory.claim({ ...owner, conversationId: 2 })]);
  expect(grants).toEqual([true, false]);
  expect(await directory.claim(owner)).toBe(true);
  expect(await directory.tombstone(owner)).toBe(true);
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
