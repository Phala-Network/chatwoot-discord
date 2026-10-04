import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { AdoptionCut } from "../src/adoption.ts";
import { LegacyArchive } from "../src/archive.ts";
import { receiptSeal } from "../src/history.ts";
import { type FrozenSource, type LegacyScanPage, legacyScanPage, validateFrozenSource } from "../src/legacy.ts";
import { withArchive } from "./fixtures/archive.ts";
import legacySchema from "./fixtures/legacy-027.ts";

const thread = "100000000000000012";

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
          interactionFence: "100",
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
