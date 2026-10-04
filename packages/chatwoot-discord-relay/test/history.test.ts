// End-to-end handover from the actual 0.27 schema9, with fictional private metadata only.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type AdoptionCut,
  importAdoptionPage,
  prepareAdoption,
  sealAdoptionHistory,
  stageAdoption,
  validateCut,
} from "../src/adoption.ts";
import { configSchema } from "../src/config.ts";
import { Conversation } from "../src/conversation.ts";
import type { Env } from "../src/env.ts";
import { nextReceiptPosition, type ReceiptPage, receiptHash, receiptPageBody, receiptSeal } from "../src/history.ts";
import {
  legacyAuditPage,
  legacyEscalationBaseline,
  legacyInventory,
  legacyKeyPage,
  legacyReceiptPage,
} from "../src/legacy.ts";
import { Store } from "../src/store.ts";
import legacySchema from "./fixtures/legacy-027.ts";
import { FORUM, json, mockFetch, on } from "./helpers.ts";

const THREAD = "100000000000040012";
const GUILD = "100000000000000044";
const discordId = (n: number) => String(100000000000090000n + BigInt(n));
let testClock = Date.now();
beforeEach(() => vi.spyOn(Date, "now").mockImplementation(() => testClock));
afterEach(() => vi.restoreAllMocks());

async function source(large = false, title = true, conversationId = 12) {
  const thread = String(100000000000040000n + BigInt(conversationId));
  return runInDurableObject(env.LEGACY_HUB.getByName(`source:${crypto.randomUUID()}`), async (_instance, state) => {
    state.storage.sql.exec(legacySchema);
    state.storage.sql.exec(
      "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor,title_subject,title,title_message_id) VALUES (3,?,?,150,?,?,?)",
      conversationId,
      thread,
      title ? "Fictional account issue" : null,
      title ? "[Acme #12] Jane Doe — Fictional account issue" : null,
      title ? 20 : null,
    );
    state.storage.sql.exec(
      "INSERT INTO posted_messages VALUES (3,?,20,0,?), (3,?,20,1,?), (3,?,21,0,?)",
      conversationId,
      discordId(20),
      conversationId,
      discordId(1020),
      conversationId,
      discordId(21),
    );
    if (large)
      for (let id = 30; id < 140; id++)
        state.storage.sql.exec("INSERT INTO posted_messages VALUES (3,?,?,0,?)", conversationId, id, discordId(id));
    state.storage.sql.exec(
      "INSERT INTO derived_messages VALUES (3,?,20,?), (3,?,21,?)",
      conversationId,
      discordId(220),
      conversationId,
      discordId(221),
    );
    // Exact derivedText baseline for an already posted failed-delivery notice.
    const text = "⚠️ A reply could not be delivered to the customer.";
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const baseline = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    state.storage.sql.exec(
      "INSERT INTO submitted_responses VALUES (3,?,20,?), (3,?,21,?)",
      conversationId,
      baseline,
      conversationId,
      baseline,
    );
    const inventory = legacyInventory(state.storage.sql);
    const pages: ReceiptPage[] = [];
    let page = await legacyReceiptPage(state.storage.sql, state.id.toString(), 3, conversationId);
    pages.push(page);
    while (!page.complete) {
      page = await legacyReceiptPage(
        state.storage.sql,
        state.id.toString(),
        3,
        conversationId,
        nextReceiptPosition(page),
      );
      pages.push(page);
    }
    return { pages, inventory, baseline, conversationId, thread };
  });
}
function manifest(fixture: Awaited<ReturnType<typeof source>>): AdoptionCut {
  const last = fixture.pages.at(-1);
  if (!last) throw new Error("Missing fixture export");
  return {
    epoch: crypto.randomUUID(),
    watermark: 200,
    interactionFence: "100",
    sourceIdentity: last.header.sourceIdentity,
    schemaVersion: 9,
    quiesced: true,
    sourcesPaused: true,
    activeCalls: 0,
    jobs: 0,
    held: 0,
    partial: 0,
    unresolved: 0,
    routingGuardsDisposition: "never-used",
    cooldownEndsAt: 0,
    historyPermissionVerified: true,
    inventoryComplete: true,
    drainEvidence: "fixture:drained-and-frozen",
    escalationBaseline: "{}",
    sourceCounts: fixture.inventory.sourceCounts,
    auditedUnthreaded: 0,
    receiptAudit: fixture.inventory.receiptAudit,
    mappings: [
      {
        accountId: 3,
        conversationId: fixture.conversationId,
        guildId: GUILD,
        forumId: FORUM,
        threadId: fixture.thread,
        generation: 1,
        cursor: 150,
        latestEligibleId: 150,
        history: receiptSeal(last),
      },
    ],
  };
}
function targetEnv(cut: AdoptionCut, phase: "maintenance" | "active"): Env {
  const config = configSchema.parse(env.CONFIG);
  const target: Env = {
    ...env,
    CONFIG: {
      ...config,
      relay: { ...config.relay, startAfterMessageId: cut.watermark },
      cutover: {
        phase,
        epoch: cut.epoch,
        interactionFence: cut.interactionFence,
        notificationsAfter: Date.now() + 3600000,
        legacyWebhooks: { [FORUM]: ["100000000000000001"] },
      },
    },
  };
  // In production CONFIG is deployed to the target DO. The pool's actual DO env is fixed;
  // execute private RPC methods on its real SQLite with the corresponding deployed CONFIG.
  target.CONVERSATION = new Proxy(env.CONVERSATION, {
    get(namespace, property, receiver) {
      if (property !== "getByName") return Reflect.get(namespace, property, receiver);
      return (name: string) => {
        const stub = namespace.getByName(name);
        return new Proxy(stub, {
          get(object, key, stubReceiver) {
            if (key === "importHistory")
              return (page: ReceiptPage) =>
                runInDurableObject(stub, (_instance, state) => new Conversation(state, target).importHistory(page));
            if (key === "sealHistory")
              return () =>
                runInDurableObject(stub, (_instance, state) => new Conversation(state, target).sealHistory());
            if (key === "readyHistory")
              return () =>
                runInDurableObject(stub, (_instance, state) => new Conversation(state, target).readyHistory());
            return Reflect.get(object, key, stubReceiver);
          },
        });
      };
    },
  });
  return target;
}

it("imports bounded schema9 history, survives restart/fault, gates cleanup, then preserves pre-W deletion and title updates across webhook rotation", async () => {
  const fixture = await source(true);
  const cut = manifest(fixture);
  expect(fixture.pages.map((p) => p.records.length)).toEqual([100, 17]);
  expect(fixture.inventory).not.toHaveProperty("responses");
  validateCut(cut);
  const maintenance = targetEnv(cut, "maintenance");
  // Exercise the supported private operator functions and real namespace routing.
  await prepareAdoption(maintenance, cut);
  await expect(stageAdoption(maintenance, cut)).rejects.toThrow(/incomplete/);
  await expect(sealAdoptionHistory(maintenance, 3, 12)).rejects.toThrow(/completely/);
  let contact = "Jane Doe";
  let deleted = false;
  let denied = true;
  let deniedAttempts = 0;
  const removed: string[] = [];
  const { requests } = mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/12", () =>
      json({
        id: 12,
        status: "resolved",
        inbox_id: 2,
        custom_attributes: { discord_thread: `https://discord.com/channels/${GUILD}/${THREAD}` },
        meta: { sender: { name: contact }, channel: "Channel::WebWidget" },
        messages: [],
      }),
    ),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/12/messages", (request) =>
      json({
        payload: request.url.searchParams.has("before")
          ? [
              { id: 20, content: "", message_type: 0, content_attributes: deleted ? { deleted: true } : {} },
              {
                id: 21,
                content: "Reply",
                message_type: 1,
                status: "failed",
                content_attributes: deleted ? { deleted: true } : {},
              },
            ]
          : [],
      }),
    ),
    on("GET", `discord.com/api/v10/channels/${THREAD}`, () => json({ id: THREAD, guild_id: GUILD, parent_id: FORUM })),
    on("GET", `discord.com/api/v10/channels/${THREAD}/messages`, () => json([])),
    on("PATCH", `discord.com/api/v10/channels/${THREAD}`, () => json({})),
    on("POST", "discord.com/api/v10/webhooks/rotated/new-token", (request) => {
      expect(JSON.parse(request.body).content).toBeUndefined();
      return json({ id: discordId(9000), channel_id: THREAD });
    }),
    on("PATCH", /^discord\.com\/api\/v10\/webhooks\/rotated\/new-token\/messages\/\d+$/, () => json({})),
    on("DELETE", new RegExp(`^discord\\.com/api/v10/channels/${THREAD}/messages/\\d+$`), (request) => {
      expect(request.headers.get("authorization")).toBe("Bot test-bot-token");
      if (denied) {
        deniedAttempts++;
        return json({ code: 50013, message: "Missing Permissions" }, { status: 403 });
      }
      removed.push(request.url.pathname.split("/").at(-1) ?? "");
      return new Response(null, { status: 204 });
    }),
  );
  await runInDurableObject(env.CONVERSATION.getByName("conversation:v1:3:12"), async (_instance, state) => {
    vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let executor = new Conversation(state, targetEnv(cut, "active"));
    await executor.enqueueConversation(3, 12);
    await executor.alarm();
    expect(requests).toHaveLength(0); // no cleanup or API work with partial/unsealed history
    executor = new Conversation(state, maintenance);
    const first = fixture.pages[0];
    const last = fixture.pages[1];
    if (!first || !last) throw new Error("Missing fixture pages");
    state.storage.sql.exec(
      "CREATE TRIGGER fail_receipts BEFORE INSERT ON posted_messages WHEN NEW.part=1 BEGIN SELECT RAISE(ABORT,'injected interruption'); END",
    );
    await expect(executor.importHistory(first)).rejects.toThrow();
    expect(new Store(state.storage.sql).legacyReceiptCounts(3, 12)).toEqual({ posted: 0, derived: 0, responses: 0 });
    expect(new Store(state.storage.sql).get("adoption:history-progress")).toBeUndefined();
    state.storage.sql.exec("DROP TRIGGER fail_receipts");
    await importAdoptionPage(maintenance, first);
    executor = new Conversation(state, maintenance);
    await executor.importHistory(first); // lost receipt/restart replay
    await expect(executor.sealHistory()).rejects.toThrow();
    await expect(executor.importHistory({ ...first, digest: "f".repeat(64) })).rejects.toThrow(/digest/);
    await executor.importHistory(last);
    await executor.sealHistory();
    await executor.sealHistory();
    const store = new Store(state.storage.sql);
    expect(store.postedResponse(3, 12, 21)).toBe(fixture.baseline);
    expect(JSON.parse(store.get("observed:3:12:derived:21") ?? "null")).toEqual({
      value: fixture.baseline,
      revision: 0,
    });
    expect(store.get("adoption:ready")).toBeUndefined();
    await stageAdoption(maintenance, cut);
    // An idempotent stage cannot change the initial private title baseline.
    const altered = structuredClone(cut);
    const alteredMapping = altered.mappings[0];
    if (!alteredMapping) throw new Error("Missing mapping");
    alteredMapping.history.header.titleSubject = "Changed";
    await expect(prepareAdoption(maintenance, altered)).rejects.toThrow(/conflict/);
    await runInDurableObject(env.FORUM_REGISTRY.getByName(`forum:v1:${FORUM}`), (_registry, registryState) => {
      registryState.storage.sql.exec(
        "INSERT OR REPLACE INTO cache VALUES ('ready',?,NULL)",
        JSON.stringify({ id: "rotated", token: "new-token", guildId: GUILD, version: 2 }),
      );
    });
    const active = targetEnv(cut, "active");
    const run = async (done = () => store.nextWakeup() === undefined) => {
      // New route domains may conservatively probe once and defer. Advance actual durable
      // alarm continuations, with a finite bound, rather than assuming one alarm completes.
      for (let attempt = 0; attempt < 12; attempt++) {
        now += 6000;
        testClock = now;
        executor = new Conversation(state, active);
        await executor.alarm();
        if (done()) return;
      }
      throw new Error("Fixture durable work did not reach its expected boundary");
    };
    await run();
    expect(store.conversation(3, 12)?.titleSubject).toBe("Fictional account issue");
    expect(store.conversation(3, 12)?.titleMessageId).toBe(20);
    expect(store.conversation(3, 12)?.cursor).toBe(200);
    contact = "Renamed Customer";
    await executor.enqueueConversation(3, 12);
    await run();
    expect(store.conversation(3, 12)?.title).toContain("Renamed Customer");
    expect(store.conversation(3, 12)?.title).toContain("Fictional account issue");
    await executor.enqueueMessageUpdate(3, 12, 21);
    await run();
    expect(requests.filter((r) => r.method === "POST" && JSON.parse(r.body).content)).toHaveLength(0); // unchanged old notice is not resent
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1); // only the fresh card
    deleted = true;
    await executor.enqueueMessageUpdate(3, 12, 20);
    await run(() => deniedAttempts > 0);
    expect(store.postedParts(3, 12, 20)).toEqual([discordId(20), discordId(1020)]); // 403 keeps receipts
    denied = false;
    await run();
    expect(store.postedParts(3, 12, 20)).toEqual([]);
    expect(store.derivedMessages(3, 12, 20)).toEqual([]);
    expect(store.conversation(3, 12)?.title).toBe("[Acme #12] Renamed Customer");
    await executor.enqueueMessageUpdate(3, 12, 21);
    await run();
    expect(store.derivedMessages(3, 12, 21)).toEqual([]);
    expect(removed).toEqual([discordId(20), discordId(1020), discordId(220), discordId(21), discordId(221)]);
    expect(store.postedParts(3, 12, 30)).toEqual([discordId(30)]); // unrelated history remains
  });
});

it("fails closed on missing receipt pages, changed checkpoints, duplicate authoritative mappings and Directory generations", async () => {
  const fixture = await source(false, true, 13);
  const cut = manifest(fixture);
  const maintenance = targetEnv(cut, "maintenance");
  await prepareAdoption(maintenance, cut);
  const THREAD = fixture.thread;
  const original = fixture.pages[0];
  if (!original) throw new Error("Missing fixture page");
  const duplicate = structuredClone(original);
  duplicate.records.push({
    ...duplicate.records[0],
    kind: 0,
    rowid: 999,
    messageId: 22,
    part: 0,
    discordId: discordId(20),
  });
  duplicate.records.sort((a, b) => a.kind - b.kind || a.rowid - b.rowid);
  const last = duplicate.records.at(-1);
  if (!last) throw new Error("Missing record");
  duplicate.next = { kind: last.kind, rowid: last.rowid };
  duplicate.digest = await receiptHash(receiptPageBody(duplicate));
  await expect(importAdoptionPage(maintenance, duplicate)).rejects.toThrow();
  await runInDurableObject(env.CONVERSATION.getByName("conversation:v1:3:13"), (_instance, state) => {
    expect(new Store(state.storage.sql).legacyReceiptCounts(3, 13)).toEqual({ posted: 0, derived: 0, responses: 0 });
  });
  const skipped = structuredClone(original);
  skipped.records.pop();
  const tail = skipped.records.at(-1);
  if (!tail) throw new Error("Missing record");
  skipped.next = { kind: tail.kind, rowid: tail.rowid };
  skipped.digest = await receiptHash(receiptPageBody(skipped));
  await expect(importAdoptionPage(maintenance, skipped)).rejects.toThrow(/seal/);
  await importAdoptionPage(maintenance, original);
  const changed = structuredClone(original);
  const record = changed.records[0];
  if (record && record.kind === 0) record.discordId = discordId(999);
  changed.digest = await receiptHash(receiptPageBody(changed));
  await expect(importAdoptionPage(maintenance, changed)).rejects.toThrow(/replay/);
  const owner = cut.mappings[0];
  if (!owner) throw new Error("Missing fixture owner");
  expect(await env.THREAD_DIRECTORY.getByName(`thread:v1:${THREAD}`).tombstone(owner)).toBe(true);
  await expect(sealAdoptionHistory(maintenance, 3, 13)).rejects.toThrow(/Directory/);
  await expect(prepareAdoption(maintenance, cut)).rejects.toThrow(/Directory/);
  const totals = structuredClone(cut);
  totals.sourceCounts.responses++;
  expect(() => validateCut(totals)).toThrow(/receipt inventory/);
  const wrongSource = structuredClone(cut);
  wrongSource.sourceIdentity = "different-source";
  expect(() => validateCut(wrongSource)).toThrow();
  const omitted = structuredClone(cut);
  omitted.mappings = [];
  expect(() => validateCut(omitted)).toThrow(/conversation inventory/);
});

it("audits orphan, conflicting, unsupported records without returning cache values or silently dropping them", async () => {
  await runInDurableObject(env.LEGACY_HUB.getByName(`audit:${crypto.randomUUID()}`), async (_instance, state) => {
    state.storage.sql.exec(legacySchema);
    state.storage.sql.exec(
      "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,12,?,150)",
      THREAD,
    );
    state.storage.sql.exec(
      "INSERT INTO posted_messages VALUES (3,12,20,0,?), (3,999,21,0,?)",
      discordId(20),
      discordId(21),
    );
    state.storage.sql.exec("INSERT INTO derived_messages VALUES (3,12,22,?)", discordId(20));
    state.storage.sql.exec("INSERT INTO submitted_responses VALUES (3,12,23,'invalid')");
    state.storage.sql.exec("INSERT INTO cache VALUES ('unexpected:authoritative','DO-NOT-EXPOSE',NULL)");
    expect(legacyInventory(state.storage.sql).receiptAudit).toEqual({
      orphaned: 1,
      conflicting: 2,
      invalid: 1,
      unsupported: 1,
    });
    const audit = legacyAuditPage(state.storage.sql);
    expect(audit.rows).toHaveLength(4);
    expect(audit.complete).toBe(true);
    expect(JSON.stringify(legacyKeyPage(state.storage.sql))).not.toContain("DO-NOT-EXPOSE");
    expect(legacyEscalationBaseline(state.storage.sql)).toBe("{}");
    state.storage.sql.exec("INSERT INTO cache VALUES ('queue:escalations',?,NULL)", '{"3:12":{"since":100,"level":2}}');
    expect(JSON.parse(legacyEscalationBaseline(state.storage.sql))).toEqual({ "3:12": { since: 100, level: 2 } });
    state.storage.sql.exec("UPDATE cache SET value='invalid' WHERE key='queue:escalations'");
    expect(() => legacyEscalationBaseline(state.storage.sql)).toThrow(/Invalid/);
    await expect(legacyReceiptPage(state.storage.sql, state.id.toString(), 3, 999)).rejects.toThrow(
      /Missing authoritative/,
    );
    await expect(legacyReceiptPage(state.storage.sql, state.id.toString(), 3, 12)).rejects.toThrow(
      /Invalid authoritative/,
    );
    state.storage.sql.exec("ALTER TABLE posted_messages ADD COLUMN unknown_field TEXT");
    expect(() => legacyInventory(state.storage.sql)).toThrow(/schema/);
  });
});

it("preserves genuinely unrecorded title metadata without renaming the historical thread", async () => {
  const fixture = await source(false, false, 14);
  const cut = manifest(fixture);
  const maintenance = targetEnv(cut, "maintenance");
  await prepareAdoption(maintenance, cut);
  for (const page of fixture.pages) await importAdoptionPage(maintenance, page);
  await sealAdoptionHistory(maintenance, 3, 14);
  await stageAdoption(maintenance, cut);
  const thread = fixture.thread;
  const { requests } = mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/14", () =>
      json({
        id: 14,
        status: "resolved",
        inbox_id: 2,
        custom_attributes: { discord_thread: `https://discord.com/channels/${GUILD}/${thread}` },
        meta: { sender: { name: "Renamed Customer" } },
        messages: [],
      }),
    ),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/14/messages", () => json({ payload: [] })),
    on("GET", `discord.com/api/v10/channels/${thread}`, () => json({ id: thread, guild_id: GUILD, parent_id: FORUM })),
    on("GET", `discord.com/api/v10/channels/${thread}/messages`, () => json([])),
    on("PATCH", `discord.com/api/v10/channels/${thread}`, () => json({})),
    on("POST", "discord.com/api/v10/webhooks/1/tok", () => json({ id: discordId(9001), channel_id: thread })),
  );
  await runInDurableObject(env.FORUM_REGISTRY.getByName(`forum:v1:${FORUM}`), (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO cache VALUES ('ready', ?, NULL)",
      JSON.stringify({ id: "1", token: "tok", guildId: GUILD, version: 1 }),
    );
  });
  await runInDurableObject(env.CONVERSATION.getByName("conversation:v1:3:14"), async (_instance, state) => {
    vi.spyOn(state.storage, "setAlarm").mockResolvedValue();
    const active = targetEnv(cut, "active");
    let executor = new Conversation(state, active);
    await executor.enqueueConversation(3, 14);
    const store = new Store(state.storage.sql);
    for (let attempt = 0; attempt < 12; attempt++) {
      testClock += 6000;
      executor = new Conversation(state, active);
      await executor.alarm();
      if (store.nextWakeup() === undefined) break;
    }
    expect(store.nextWakeup()).toBeUndefined();
    const row = store.conversation(3, 14);
    expect(row?.threadId).toBe(thread);
    expect(row?.titleSubject).toBeUndefined();
    expect(row?.title).toBeUndefined();
    expect(row?.titleMessageId).toBeUndefined();
    expect(requests.filter((r) => r.method === "PATCH").every((r) => JSON.parse(r.body).name === undefined)).toBe(true);
  });
});

it("blocks ambiguous nonempty titles and response baselines without authoritative derived receipts", async () => {
  await runInDurableObject(
    env.LEGACY_HUB.getByName(`missing-title:${crypto.randomUUID()}`),
    async (_instance, state) => {
      state.storage.sql.exec(legacySchema);
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor,title_subject,title) VALUES (3,12,?,150,'Fictional subject','Fictional title')",
        THREAD,
      );
      expect(legacyInventory(state.storage.sql).receiptAudit.invalid).toBe(1);
      expect(legacyAuditPage(state.storage.sql).rows).toMatchObject([{ kind: 3, issue: "invalid" }]);
      await expect(legacyReceiptPage(state.storage.sql, state.id.toString(), 3, 12)).rejects.toThrow(/association/);
      state.storage.sql.exec("UPDATE conversations SET title_message_id=20");
      await expect(legacyReceiptPage(state.storage.sql, state.id.toString(), 3, 12)).rejects.toThrow(/title receipt/);
      state.storage.sql.exec("UPDATE conversations SET title_subject=NULL,title=NULL,title_message_id=NULL");
      state.storage.sql.exec("INSERT INTO submitted_responses VALUES (3,12,23,?)", "a".repeat(64));
      expect(legacyInventory(state.storage.sql).receiptAudit.invalid).toBe(1);
      expect(legacyAuditPage(state.storage.sql).rows).toMatchObject([{ kind: 2, messageId: 23, issue: "invalid" }]);
      state.storage.sql.exec("INSERT INTO derived_messages VALUES (3,12,24,?)", discordId(24));
      expect(legacyInventory(state.storage.sql).receiptAudit.invalid).toBe(2);
      expect(legacyAuditPage(state.storage.sql).rows).toMatchObject([
        { kind: 1, messageId: 24, issue: "invalid" },
        { kind: 2, messageId: 23, issue: "invalid" },
      ]);
    },
  );
  // Even a falsely clean operator audit cannot seal an unpaired target baseline.
  const fixture = await source(false, false, 15);
  const page = fixture.pages[0];
  if (!page) throw new Error("Missing fixture page");
  page.records = page.records.filter((record) => record.kind !== 2 || record.messageId !== 20);
  page.header.counts.responses--;
  page.previous = await receiptHash(page.header);
  page.digest = await receiptHash(receiptPageBody(page));
  fixture.inventory.sourceCounts.responses--;
  const cut = manifest(fixture);
  const maintenance = targetEnv(cut, "maintenance");
  await prepareAdoption(maintenance, cut);
  await importAdoptionPage(maintenance, page);
  await expect(sealAdoptionHistory(maintenance, 3, 15)).rejects.toThrow(/not paired/);
  await expect(stageAdoption(maintenance, cut)).rejects.toThrow(/incomplete/);
});
