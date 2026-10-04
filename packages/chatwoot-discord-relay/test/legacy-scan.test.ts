import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { AdoptionCut, AdoptionMapping } from "../src/adoption.ts";
import { LegacyArchive } from "../src/archive.ts";
import { nextReceiptPosition, receiptHash, receiptPageBody, receiptSeal } from "../src/history.ts";
import { type FrozenSource, type LegacyScanPage, legacyScanPage, validateFrozenSource } from "../src/legacy.ts";
import { withArchive } from "./fixtures/archive.ts";
import legacySchema from "./fixtures/legacy-027.ts";

const thread = "100000000000000012";
function archiveCut(archive: LegacyArchive, source: FrozenSource, mappings: AdoptionMapping[] = []): AdoptionCut {
  const inventory = archive.inventory();
  return {
    epoch: source.epoch,
    watermark: 150,
    interactionFence: inventory.interactionFence,
    sourceIdentity: source.sourceIdentity,
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
    mappings,
    inventoryComplete: true,
    drainEvidence: source.drainEvidence,
    escalationBaseline: archive.escalationBaseline(source),
    sourceCounts: inventory.sourceCounts,
    auditedUnthreaded: inventory.sourceCounts.conversations - mappings.length,
    receiptAudit: inventory.receiptAudit,
  };
}
function mapping(history: AdoptionMapping["history"]): AdoptionMapping {
  return {
    accountId: history.header.accountId,
    conversationId: history.header.conversationId,
    threadId: history.header.threadId,
    guildId: "100000000000000044",
    forumId: "100000000000000055",
    generation: 1,
    cursor: history.header.cursor,
    latestEligibleId: history.header.cursor,
    history,
  };
}

it("bounds source execution by indexed rowid pages, fences unfrozen access, and never copies overlong text", async () => {
  await runInDurableObject(env.LEGACY_HUB.getByName(`bounded:${crypto.randomUUID()}`), async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(legacySchema);
    sql.exec("INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,12,?,3000)", thread);
    for (let id = 1; id <= 2000; id++)
      sql.exec("INSERT INTO posted_messages VALUES (3,12,?,0,?)", id, String(100000000000020000n + BigInt(id)));
    sql.exec("INSERT INTO cache VALUES (?, 'PRIVATE-VALUE',NULL)", "界".repeat(2000));
    const source: FrozenSource = {
      sourceIdentity: state.id.toString(),
      epoch: "frozen",
      drainEvidence: "settled",
      frozen: true,
    };
    const spy = vi.spyOn(sql, "exec");
    const page = await legacyScanPage(sql, source, { kind: 1, rowid: 0 });
    expect(page.rows).toHaveLength(100);
    expect(page.next).toEqual({ kind: 1, rowid: 100 });
    expect(spy.mock.calls.every(([query]) => !/(COUNT\(|GROUP BY|UNION|JOIN)/i.test(query))).toBe(true);
    for (const result of spy.mock.results)
      if (result.type === "return") {
        expect(result.value.rowsRead).toBeLessThanOrEqual(100);
        expect(result.value.rowsWritten).toBe(0);
      }
    spy.mockRestore();
    const keys = await legacyScanPage(sql, source, { kind: 4, rowid: 0 });
    expect(keys.rows).toMatchObject([{ key: null, invalid_text: 1 }]);
    expect(JSON.stringify(keys)).not.toContain("PRIVATE-VALUE");
    expect(JSON.stringify(keys)).not.toContain("界");
    expect(() => validateFrozenSource({ ...source, frozen: false })).toThrow(/frozen source boundary/);
    await withArchive(state, (archive) => expect(archive.inventory().receiptAudit.unsupported).toBe(1));
  });
});

it("reports the same safe-integer, thread and UTF-8 failures that export rejects with owner/row diagnostics", async () => {
  await runInDurableObject(env.LEGACY_HUB.getByName(`invalid:${crypto.randomUUID()}`), async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(legacySchema);
    sql.exec(
      "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,12,?,150),(3,13,'bad-thread',150)",
      thread,
    );
    sql.exec(
      "INSERT INTO posted_messages VALUES (9007199254740992,12,20,0,'100000000000000020'),(3,9007199254740992,21,0,'100000000000000021'),(3,12,22,9007199254740992,'100000000000000022')",
    );
    // SQLite can store non-finite REAL in an INTEGER-affinity nullable column. It must
    // not turn into JSON null and falsely acquire unrecorded title provenance.
    sql.exec(
      "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor,title_subject,title,title_message_id) VALUES (3,14,'100000000000000014',150,'Subject','Title',9e999)",
    );
    sql.exec("INSERT INTO submitted_responses VALUES (3,12,23,'invalid')");
    sql.exec(
      "UPDATE conversations SET title_subject=?,title=? WHERE conversation_id=12",
      "界".repeat(2000),
      "界".repeat(2000),
    );
    await withArchive(state, async (archive) => {
      expect(archive.inventory().receiptAudit.invalid).toBe(7);
      const rows = archive.auditPage().rows;
      expect(rows).toHaveLength(7);
      expect(rows).toContainEqual(
        expect.objectContaining({ kind: 1, accountId: 3, conversationId: 12, messageId: 22, issues: ["invalid"] }),
      );
      await expect(archive.receiptPage(3, 12)).rejects.toThrow(/unresolved audit/);
    });
  });
});

it("persists source checkpoints atomically, rejects partial scans/replays and resumes audit after operator restart", async () => {
  const sourceStub = env.LEGACY_HUB.getByName(`scan-source:${crypto.randomUUID()}`);
  const fixture = await runInDurableObject(sourceStub, async (_instance, state) => {
    state.storage.sql.exec(legacySchema);
    state.storage.sql.exec(
      "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,12,?,150)",
      thread,
    );
    const source: FrozenSource = {
      sourceIdentity: state.id.toString(),
      epoch: "immutable",
      drainEvidence: "settled",
      frozen: true,
    };
    const pages: LegacyScanPage[] = [];
    let after = { kind: 0, rowid: 0 };
    for (let i = 0; i < 10; i++) {
      const page = await legacyScanPage(state.storage.sql, source, after);
      pages.push(page);
      after = page.next;
      if (page.complete) break;
    }
    return { source, pages };
  });
  await runInDurableObject(
    env.LEGACY_HUB.getByName(`scan-archive:${crypto.randomUUID()}`),
    async (_instance, state) => {
      const construct = () => new LegacyArchive(state.storage.sql, (run) => state.storage.transactionSync(run));
      let archive = construct();
      archive.open(fixture.source);
      const first = fixture.pages[0];
      if (!first) throw new Error("Missing fixture page");
      state.storage.sql.exec(
        "CREATE TRIGGER interrupt_archive BEFORE INSERT ON legacy_archive_pages BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
      );
      await expect(archive.collect(first)).rejects.toThrow();
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM legacy_archive_rows").one().n).toBe(0);
      state.storage.sql.exec("DROP TRIGGER interrupt_archive");
      await archive.collect(first);
      archive = construct();
      await archive.collect(first);
      expect(() => archive.auditNext()).toThrow(/scan is incomplete/);
      expect(() => archive.inventory()).toThrow(/audit is incomplete/);
      await expect(archive.collect({ ...first, digest: "f".repeat(64) })).rejects.toThrow(/Invalid/);
      for (const page of fixture.pages.slice(1)) await archive.collect(page);
      expect(archive.open(fixture.source).complete).toBe(true);
      expect(() => archive.open({ ...fixture.source, epoch: "other" })).toThrow(/conflict/);
      expect(archive.auditNext().complete).toBe(false);
      archive = construct();
      for (let i = 0; i < 10; i++) if (archive.auditNext().complete) break;
      expect(archive.inventory().sourceCounts).toEqual({
        conversations: 1,
        threads: 1,
        posted: 0,
        derived: 0,
        responses: 0,
      });
      expect((await archive.receiptPage(3, 12)).complete).toBe(true);
    },
  );
});

it("binds the expected complete 53-owner set to the frozen archive before operator prepare/verify/stage", async () => {
  await runInDurableObject(
    env.LEGACY_HUB.getByName(`expected-set:${crypto.randomUUID()}`),
    async (_instance, state) => {
      state.storage.sql.exec(legacySchema);
      for (let id = 1; id <= 53; id++)
        state.storage.sql.exec(
          "INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,?,?,101)",
          id,
          String(100000000000060000n + BigInt(id)),
        );
      await withArchive(state, async (archive, source) => {
        const inventory = archive.inventory();
        const mappings = [];
        for (let id = 1; id <= 53; id++) {
          const page = await archive.receiptPage(3, id);
          mappings.push({
            accountId: 3,
            conversationId: id,
            threadId: page.header.threadId,
            guildId: "100000000000000044",
            forumId: "100000000000000055",
            generation: 1,
            cursor: 101,
            latestEligibleId: 101,
            history: receiptSeal(page),
          });
        }
        const cut: AdoptionCut = {
          epoch: source.epoch,
          watermark: 101,
          interactionFence: inventory.interactionFence,
          sourceIdentity: source.sourceIdentity,
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
          mappings,
          inventoryComplete: true,
          drainEvidence: source.drainEvidence,
          escalationBaseline: "{}",
          sourceCounts: inventory.sourceCounts,
          auditedUnthreaded: 0,
          receiptAudit: inventory.receiptAudit,
        };
        expect(() => archive.assertCut(cut)).not.toThrow();
        const subset = {
          ...cut,
          mappings: cut.mappings.slice(0, 2),
          sourceCounts: { ...cut.sourceCounts, threads: 2, conversations: 2 },
        };
        expect(() => archive.assertCut(subset)).toThrow(/complete frozen archive/);
        expect(() => archive.assertCut({ ...cut, epoch: "another" })).toThrow();
        const altered = structuredClone(cut);
        const mapping = altered.mappings[0];
        if (!mapping) throw new Error("Missing mapping");
        mapping.history.header.titleSubject = "Changed private title";
        mapping.history.header.title = "Changed private title";
        mapping.history.header.titleAssociation = "never-recorded-or-unresolved";
        expect(() => archive.assertCut(altered)).toThrow(/header differs/);
      });
    },
  );
});

it("seals every authoritative page durably and rejects forged Discord IDs or baselines with unchanged headers/counts", async () => {
  await runInDurableObject(env.LEGACY_HUB.getByName(`canonical:${crypto.randomUUID()}`), async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(legacySchema);
    sql.exec("INSERT INTO conversations (account_id,conversation_id,thread_id,cursor) VALUES (3,12,?,150)", thread);
    for (let id = 1; id <= 105; id++)
      sql.exec("INSERT INTO posted_messages VALUES (3,12,?,0,?)", id, String(100000000000020000n + BigInt(id)));
    sql.exec("INSERT INTO derived_messages VALUES (3,12,106,'100000000000030106')");
    sql.exec("INSERT INTO submitted_responses VALUES (3,12,106,?)", "a".repeat(64));
    await withArchive(state, async (archive, source, archiveState) => {
      const queries = vi.spyOn(archiveState.storage.sql, "exec");
      const first = await archive.receiptPage(3, 12);
      expect(queries.mock.calls.every(([query]) => !/(COUNT\(|GROUP BY|UNION|JOIN)/i.test(query))).toBe(true);
      for (const result of queries.mock.results)
        if (result.type === "return") expect(result.value.rowsRead).toBeLessThanOrEqual(101);
      queries.mockRestore();
      expect(first.records).toHaveLength(100);
      expect(first.complete).toBe(false);
      expect(() => archive.receiptSeal(3, 12)).toThrow(/incomplete/);
      expect(() =>
        archive.assertCut(
          archiveCut(archive, source, [mapping({ header: first.header, pages: 2, digest: "f".repeat(64) })]),
        ),
      ).toThrow(/incomplete/);
      await expect(archive.receiptPage(3, 12, { ...nextReceiptPosition(first), index: 2 })).rejects.toThrow(
        /checkpoint/,
      );
      await expect(
        archive.receiptPage(3, 12, { ...nextReceiptPosition(first), previous: "f".repeat(64) }),
      ).rejects.toThrow(/checkpoint/);
      expect(await archive.receiptPage(3, 12)).toEqual(first);
      archiveState.storage.sql.exec(
        "CREATE TRIGGER interrupt_receipt_export BEFORE INSERT ON legacy_archive_receipt_progress BEGIN SELECT RAISE(ABORT,'fixture interruption'); END",
      );
      await expect(archive.receiptPage(3, 12, nextReceiptPosition(first))).rejects.toThrow();
      expect(() => archive.receiptSeal(3, 12)).toThrow(/incomplete/);
      archiveState.storage.sql.exec("DROP TRIGGER interrupt_receipt_export");
      archive = new LegacyArchive(archiveState.storage.sql, (run) => archiveState.storage.transactionSync(run));
      const last = await archive.receiptPage(3, 12, nextReceiptPosition(first));
      expect(last.complete).toBe(true);
      expect(last.records).toHaveLength(7);
      const history = archive.receiptSeal(3, 12);
      const cut = archiveCut(archive, source, [mapping(history)]);
      expect(() => archive.assertCut(cut)).not.toThrow();
      expect(await archive.receiptPage(3, 12, nextReceiptPosition(first))).toEqual(last);
      const forgedFirst = structuredClone(first);
      const original = forgedFirst.records[0];
      if (original?.kind !== 0) throw new Error("Missing original fixture receipt");
      original.discordId = "100000000000099999";
      forgedFirst.digest = await receiptHash(receiptPageBody(forgedFirst));
      const forgedLast = { ...last, previous: forgedFirst.digest };
      forgedLast.digest = await receiptHash(receiptPageBody(forgedLast));
      expect(() => archive.assertCut(archiveCut(archive, source, [mapping(receiptSeal(forgedLast))]))).toThrow(
        /seal differs/,
      );
      const forgedBaseline = structuredClone(last);
      const response = forgedBaseline.records.find((record) => record.kind === 2);
      if (response?.kind !== 2) throw new Error("Missing response fixture baseline");
      response.digest = "b".repeat(64);
      forgedBaseline.digest = await receiptHash(receiptPageBody(forgedBaseline));
      expect(() => archive.assertCut(archiveCut(archive, source, [mapping(receiptSeal(forgedBaseline))]))).toThrow(
        /seal differs/,
      );
      expect(() => archive.assertCut(archiveCut(archive, source, [mapping({ ...history, pages: 1 })]))).toThrow(
        /seal differs/,
      );
    });
  });
});

it.for(["jobs", "partial", "card", "send", "effect", "route", "interaction"] as const)(
  "enforces archived %s evidence even when the caller supplies zero gates and no mappings",
  async (kind) => {
    await runInDurableObject(env.LEGACY_HUB.getByName(`gate:${crypto.randomUUID()}`), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(legacySchema);
      sql.exec("INSERT INTO conversations (account_id,conversation_id,cursor) VALUES (3,12,100)");
      if (kind === "jobs")
        sql.exec("INSERT INTO jobs (key,priority,payload,not_before,created_at) VALUES ('fixture',1,'{}',0,0)");
      if (kind === "partial") sql.exec("INSERT INTO posted_messages VALUES (3,12,101,0,'100000000000000101')");
      if (kind === "card") sql.exec("UPDATE conversations SET card_id='?unknown' WHERE conversation_id=12");
      if (kind === "send") sql.exec("INSERT INTO cache VALUES ('send:fixture','unknown',NULL)");
      if (kind === "effect") sql.exec("INSERT INTO cache VALUES ('effect:fixture','{\"state\":\"DISPATCHING\"}',NULL)");
      if (kind === "route") sql.exec("INSERT INTO cache VALUES ('kind-reply:3:12','1',NULL)");
      if (kind === "interaction") sql.exec("INSERT INTO interactions VALUES ('100',0)");
      await withArchive(state, (archive, source) => {
        const cut = archiveCut(archive, source);
        if (kind === "interaction") {
          expect(() => archive.assertCut(cut)).not.toThrow();
          expect(() => archive.assertCut({ ...cut, interactionFence: "0" })).toThrow(/complete frozen archive/);
        } else {
          expect(() => archive.assertCut(cut)).toThrow(/complete frozen archive/);
          if (kind === "route")
            expect(() => archive.assertCut({ ...cut, routingGuardsDisposition: "independent-router" })).toThrow(
              /complete frozen archive/,
            );
        }
      });
    });
  },
);

it("binds canonical escalation state to the frozen cache checkpoint and rejects stale baseline/replay", async () => {
  await runInDurableObject(env.LEGACY_HUB.getByName(`escalation:${crypto.randomUUID()}`), async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(legacySchema);
    sql.exec("INSERT INTO cache VALUES ('queue:escalations',?,NULL)", '{"3:12":{"level":2,"since":100}}');
    const source: FrozenSource = {
      sourceIdentity: state.id.toString(),
      epoch: "fixture",
      drainEvidence: "fixture:settled",
      frozen: true,
    };
    const original = await legacyScanPage(sql, source, { kind: 4, rowid: 0 });
    const pages: LegacyScanPage[] = [];
    for (let kind = 0; kind <= 4; kind++) pages.push(await legacyScanPage(sql, source, { kind, rowid: 0 }));
    expect(original.escalationBaseline).toBe('{"3:12":{"since":100,"level":2}}');
    await withArchive(state, (archive, boundary) => {
      const cut = archiveCut(archive, boundary);
      expect(() => archive.assertCut(cut)).not.toThrow();
      expect(() => archive.assertCut({ ...cut, escalationBaseline: "{}" })).toThrow(/complete frozen archive/);
    });
    await runInDurableObject(
      env.LEGACY_HUB.getByName(`baseline-replay:${crypto.randomUUID()}`),
      async (_instance, archiveState) => {
        const archive = new LegacyArchive(archiveState.storage.sql, (run) => archiveState.storage.transactionSync(run));
        archive.open(source);
        for (const page of pages) await archive.collect(page);
        await archive.collect(original);
        const changed = { ...original, escalationBaseline: "{}" };
        const { digest: _digest, ...body } = changed;
        changed.digest = await receiptHash(body);
        await expect(archive.collect(changed)).rejects.toThrow(/Conflicting frozen scan replay/);
      },
    );
  });
});

it("enforces encoded UTF-8 bytes before accepting a private collector response", async () => {
  await runInDurableObject(env.LEGACY_HUB.getByName(`bytes:${crypto.randomUUID()}`), async (_instance, state) => {
    state.storage.sql.exec(legacySchema);
    const source: FrozenSource = {
      sourceIdentity: state.id.toString(),
      epoch: "fixture",
      drainEvidence: "fixture:settled",
      frozen: true,
    };
    const page = await legacyScanPage(state.storage.sql, source);
    page.rows = [{ rowid: 1, title: "界".repeat(750000) }];
    const { digest: _digest, ...body } = page;
    page.digest = await receiptHash(body);
    expect(JSON.stringify(page).length).toBeLessThan(2 * 1024 * 1024);
    const archive = new LegacyArchive(state.storage.sql, (run) => state.storage.transactionSync(run));
    archive.open(source);
    await expect(archive.collect(page)).rejects.toThrow(/Invalid frozen scan page/);
  });
});
