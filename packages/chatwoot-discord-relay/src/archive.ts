// Private operator SQLite spool. Source calls only scan bounded rowid ranges; all relational
// validation and receipt packaging run here, away from the retired legacy executor.
import { z } from "zod";
import type { AdoptionCut } from "./adoption.ts";
import {
  baselineLinkageSchema,
  canonicalHeader,
  type ReceiptCounts,
  type ReceiptHeader,
  type ReceiptPage,
  type ReceiptPosition,
  receiptHash,
  receiptHeaderSchema,
  receiptPageBody,
  recordSchema,
  titleAssociation,
  validateReceiptPage,
  validateTitleMetadata,
} from "./history.ts";
import {
  type FrozenSource,
  type LegacyPosition,
  type LegacyRow,
  type LegacyScanPage,
  legacyTables,
  validateFrozenSource,
} from "./legacy.ts";

const zeroCounts = () => ({ conversations: 0, threads: 0, posted: 0, derived: 0, responses: 0 });
const zeroAudit = () => ({ orphaned: 0, conflicting: 0, invalid: 0, unsupported: 0, unresolved: 0 });
interface State {
  source: FrozenSource;
  schemaVersion?: 9 | 10;
  scan: LegacyPosition;
  collected: boolean;
  audit: LegacyPosition;
  complete: boolean;
  counts: ReturnType<typeof zeroCounts>;
  issues: ReturnType<typeof zeroAudit>;
  jobs: number;
  partial: number;
  routingGuards: number;
  unknownGuards: number;
  unknownCards: number;
  interactionFence: string;
}
const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const numericConversation = z.object({
  account_id: safeId,
  conversation_id: safeId,
  cursor: safeCount.nullable(),
  title_message_id: safeId.nullable(),
});
const supportedKey =
  /^(forum:.*:(guild|webhook)|discord:application|answer:.*|sweep:.*:(last|pass)|inbox:.*|avatar:.*|triage:.*|card-backfill:.*|queue:escalations|route:.*|kind-reply:.*|kind-answered:.*)$/;

export class LegacyArchive {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: (run: () => void) => void,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS legacy_archive_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_archive_pages (kind INTEGER,rowid INTEGER,digest TEXT NOT NULL,PRIMARY KEY(kind,rowid));
      CREATE TABLE IF NOT EXISTS legacy_archive_rows (kind INTEGER,rowid INTEGER,account_id INTEGER,conversation_id INTEGER,message_id INTEGER,discord_id TEXT,value TEXT NOT NULL,PRIMARY KEY(kind,rowid));
      CREATE INDEX IF NOT EXISTS legacy_archive_receipt_page ON legacy_archive_rows(kind,account_id,conversation_id,rowid);
      CREATE INDEX IF NOT EXISTS legacy_archive_owner ON legacy_archive_rows(kind,account_id,conversation_id,message_id,rowid);
      CREATE INDEX IF NOT EXISTS legacy_archive_discord ON legacy_archive_rows(discord_id);
      CREATE TABLE IF NOT EXISTS legacy_archive_dispositions (account_id INTEGER,conversation_id INTEGER,message_id INTEGER,digest TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(account_id,conversation_id,message_id));
      CREATE TABLE IF NOT EXISTS legacy_archive_issues (kind INTEGER,rowid INTEGER,issue TEXT,PRIMARY KEY(kind,rowid,issue));`);
  }
  private state(): State {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM legacy_archive_state WHERE id=1").toArray()[0];
    if (!row) throw new Error("Frozen archive has not been opened");
    return JSON.parse(row.value);
  }
  private save(state: State) {
    this.sql.exec("INSERT OR REPLACE INTO legacy_archive_state VALUES (1,?)", JSON.stringify(state));
  }
  open(source: FrozenSource) {
    source = validateFrozenSource(source);
    this.transaction(() => {
      const prior = this.sql.exec<{ value: string }>("SELECT value FROM legacy_archive_state WHERE id=1").toArray()[0];
      if (prior) {
        if (JSON.stringify(JSON.parse(prior.value).source) !== JSON.stringify(source))
          throw new Error("Frozen archive boundary conflict");
        return;
      }
      this.save({
        source,
        scan: { kind: 0, rowid: 0 },
        collected: false,
        audit: { kind: 0, rowid: 0 },
        complete: false,
        counts: zeroCounts(),
        issues: zeroAudit(),
        jobs: 0,
        partial: 0,
        routingGuards: 0,
        unknownGuards: 0,
        unknownCards: 0,
        interactionFence: "0",
      });
    });
    return { next: this.state().scan, complete: this.state().collected };
  }
  async collect(page: LegacyScanPage) {
    const { digest, ...body } = page;
    if (JSON.stringify(page).length > 2 * 1024 * 1024 || page.rows.length > 100 || (await receiptHash(body)) !== digest)
      throw new Error("Invalid frozen scan page");
    this.transaction(() => {
      const state = this.state();
      if (
        JSON.stringify(state.source) !== JSON.stringify(validateFrozenSource(page.source)) ||
        (state.schemaVersion !== undefined && state.schemaVersion !== page.schemaVersion)
      )
        throw new Error("Frozen scan source changed");
      const saved = this.sql
        .exec<{ digest: string }>(
          "SELECT digest FROM legacy_archive_pages WHERE kind=? AND rowid=?",
          page.after.kind,
          page.after.rowid,
        )
        .toArray()[0];
      if (saved) {
        if (saved.digest !== digest) throw new Error("Conflicting frozen scan replay");
        return;
      }
      if (state.collected || JSON.stringify(state.scan) !== JSON.stringify(page.after))
        throw new Error("Frozen scan checkpoint conflict");
      let last = page.after.rowid;
      for (const row of page.rows) {
        if (
          !Number.isSafeInteger(row.rowid) ||
          row.rowid <= last ||
          Object.values(row).some((value) => value !== null && typeof value !== "number" && typeof value !== "string")
        )
          throw new Error("Invalid frozen scan row");
        last = row.rowid;
        this.sql.exec(
          "INSERT INTO legacy_archive_rows VALUES (?,?,?,?,?,?,?)",
          page.after.kind,
          row.rowid,
          row.account_id ?? null,
          row.conversation_id ?? null,
          row.message_id ?? null,
          row.discord_message_id ?? null,
          JSON.stringify(row),
        );
      }
      const end = page.rows.length < 100;
      const complete = end && page.after.kind === legacyTables.length - 1;
      const next = end && !complete ? { kind: page.after.kind + 1, rowid: 0 } : { kind: page.after.kind, rowid: last };
      if (
        JSON.stringify(next) !== JSON.stringify(page.next) ||
        complete !== page.complete ||
        ![9, 10].includes(page.schemaVersion)
      )
        throw new Error("Incomplete frozen scan page");
      state.schemaVersion = page.schemaVersion;
      state.scan = next;
      state.collected = complete;
      this.sql.exec("INSERT INTO legacy_archive_pages VALUES (?,?,?)", page.after.kind, page.after.rowid, digest);
      this.save(state);
    });
    return { next: this.state().scan, complete: this.state().collected };
  }
  private rows(kind: number, after: number) {
    return this.sql
      .exec<{ value: string }>(
        "SELECT value FROM legacy_archive_rows WHERE kind=? AND rowid>? ORDER BY rowid LIMIT 100",
        kind,
        after,
      )
      .toArray()
      .map(({ value }): LegacyRow => JSON.parse(value));
  }
  private exists(kind: number, row: LegacyRow) {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM legacy_archive_rows WHERE kind=? AND account_id=? AND conversation_id=? AND message_id=? LIMIT 1",
          kind,
          row.account_id ?? null,
          row.conversation_id ?? null,
          row.message_id ?? null,
        )
        .toArray().length > 0
    );
  }
  private conversation(row: LegacyRow): LegacyRow | undefined {
    const found = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM legacy_archive_rows WHERE kind=0 AND account_id=? AND conversation_id=? LIMIT 1",
        row.account_id ?? null,
        row.conversation_id ?? null,
      )
      .toArray()[0];
    return found ? JSON.parse(found.value) : undefined;
  }
  private linkage(row: LegacyRow): z.infer<typeof baselineLinkageSchema> {
    if (this.exists(2, row)) return { state: "recorded" };
    const disposition = this.sql
      .exec<{ digest: string; evidence: string }>(
        "SELECT digest,evidence FROM legacy_archive_dispositions WHERE account_id=? AND conversation_id=? AND message_id=?",
        row.account_id ?? null,
        row.conversation_id ?? null,
        row.message_id ?? null,
      )
      .toArray()[0];
    return disposition && disposition.digest === row.digest
      ? { state: "deleted-source", evidenceRef: disposition.evidence }
      : { state: "unresolved" };
  }
  /** Authoritative deleted-source evidence only. No ID is created; the existing digest stays.
   * Must be supplied before audit/export, bound to this frozen source and exact baseline. */
  disposition(
    source: FrozenSource,
    accountId: number,
    conversationId: number,
    messageId: number,
    digest: string,
    evidenceRef: string,
  ) {
    const parsed = baselineLinkageSchema.safeParse({ state: "deleted-source", evidenceRef });
    if (
      ![accountId, conversationId, messageId].every((id) => safeId.safeParse(id).success) ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !parsed.success
    )
      throw new Error("Invalid deleted-source disposition");
    this.transaction(() => {
      const state = this.state();
      if (
        !state.collected ||
        state.audit.kind !== 0 ||
        state.audit.rowid !== 0 ||
        state.complete ||
        JSON.stringify(validateFrozenSource(source)) !== JSON.stringify(state.source)
      )
        throw new Error("Disposition requires the complete unaudited frozen source");
      const row = this.sql
        .exec<{ value: string }>(
          "SELECT value FROM legacy_archive_rows WHERE kind=3 AND account_id=? AND conversation_id=? AND message_id=?",
          accountId,
          conversationId,
          messageId,
        )
        .toArray()[0];
      if (!row || JSON.parse(row.value).digest !== digest || this.exists(2, JSON.parse(row.value)))
        throw new Error("Disposition conflicts with authoritative baseline/receipt");
      const prior = this.sql
        .exec<{ digest: string; evidence: string }>(
          "SELECT digest,evidence FROM legacy_archive_dispositions WHERE account_id=? AND conversation_id=? AND message_id=?",
          accountId,
          conversationId,
          messageId,
        )
        .toArray()[0];
      if (prior && (prior.digest !== digest || prior.evidence !== evidenceRef))
        throw new Error("Conflicting deleted-source disposition");
      this.sql.exec(
        "INSERT OR IGNORE INTO legacy_archive_dispositions VALUES (?,?,?,?,?)",
        accountId,
        conversationId,
        messageId,
        digest,
        evidenceRef,
      );
    });
  }
  private header(row: LegacyRow, counts: ReceiptCounts): ReceiptHeader {
    const metadata = { titleSubject: row.title_subject, title: row.title, titleMessageId: row.title_message_id };
    const association =
      row.title_message_id !== null
        ? "recorded"
        : row.title_subject !== null || row.title !== null
          ? "never-recorded-or-unresolved"
          : "absent";
    const parsed = receiptHeaderSchema.safeParse({
      ...metadata,
      titleAssociation: association,
      sourceIdentity: this.state().source.sourceIdentity,
      schemaVersion: this.state().schemaVersion,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      threadId: row.thread_id,
      cursor: row.cursor,
      counts,
    });
    if (!parsed.success || row.invalid_text || row.invalid_numeric)
      throw new Error("Invalid authoritative conversation metadata");
    validateTitleMetadata(parsed.data);
    return canonicalHeader(parsed.data);
  }
  private record(row: LegacyRow, kind: number) {
    const base = { kind: kind - 1, rowid: row.rowid, messageId: row.message_id };
    const parsed = recordSchema.safeParse(
      kind === 1
        ? { ...base, part: row.part, discordId: row.discord_message_id }
        : kind === 2
          ? { ...base, discordId: row.discord_message_id }
          : { ...base, digest: row.digest, linkage: this.linkage(row) },
    );
    if (
      !parsed.success ||
      row.invalid_text ||
      !safeId.safeParse(row.account_id).success ||
      !safeId.safeParse(row.conversation_id).success
    )
      throw new Error("Invalid authoritative receipt");
    return parsed.data;
  }
  /** Incremental audit: one local indexed page per invocation, never rescans the source. */
  auditNext() {
    this.transaction(() => {
      const state = this.state();
      if (!state.collected) throw new Error("Frozen scan is incomplete");
      if (state.complete) return;
      const { kind, rowid } = state.audit;
      const rows = this.rows(kind, rowid);
      for (const row of rows) {
        const issues = new Set<keyof State["issues"]>();
        if (kind === 0) {
          state.counts.conversations++;
          if (row.thread_id !== null || row.invalid_text) state.counts.threads++;
          state.unknownCards += Number(row.unknown_card ?? 0);
          try {
            if (!numericConversation.safeParse(row).success || row.invalid_text || row.invalid_numeric)
              throw new Error("Invalid");
            if (row.thread_id !== null) {
              const header = this.header(row, { posted: 0, derived: 0, responses: 0 });
              if (header.titleAssociation !== titleAssociation(header)) throw new Error("Invalid");
              if (
                header.titleSubject &&
                header.titleMessageId !== null &&
                !this.exists(1, { ...row, message_id: header.titleMessageId })
              )
                issues.add("invalid");
            } else if (row.title_subject !== null || row.title !== null || row.title_message_id !== null)
              issues.add("orphaned");
          } catch {
            issues.add("invalid");
          }
        } else if (kind < 4) {
          if (kind === 1) state.counts.posted++;
          else if (kind === 2) state.counts.derived++;
          else state.counts.responses++;
          const conversation = this.conversation(row);
          if (!conversation || conversation.thread_id === null) issues.add("orphaned");
          try {
            const record = this.record(row, kind);
            if (
              !conversation ||
              !safeCount.safeParse(conversation.cursor).success ||
              record.messageId > Number(conversation.cursor)
            ) {
              issues.add("invalid");
              state.partial++;
            }
            if (kind === 2 && !this.exists(3, row)) issues.add("invalid");
            if (kind === 3 && this.linkage(row).state === "unresolved") issues.add("unresolved");
          } catch {
            issues.add("invalid");
          }
          if (
            row.discord_message_id !== undefined &&
            row.discord_message_id !== null &&
            this.sql
              .exec("SELECT 1 FROM legacy_archive_rows WHERE discord_id=? LIMIT 2", row.discord_message_id)
              .toArray().length > 1
          )
            issues.add("conflicting");
        } else if (kind === 4) {
          if (typeof row.key !== "string" || row.invalid_text || !supportedKey.test(row.key)) issues.add("unsupported");
          if (typeof row.key === "string" && /^(route:|kind-reply:|kind-answered:)/.test(row.key))
            state.routingGuards++;
          state.unknownGuards += Number(row.unknown_guard ?? 0);
          if (row.oversized_guard) issues.add("invalid");
        } else if (kind === 5) state.jobs++;
        else {
          if (row.invalid_text || typeof row.id !== "string" || !/^\d{1,20}$/.test(row.id)) issues.add("invalid");
          else if (BigInt(row.id) > BigInt(state.interactionFence)) state.interactionFence = String(BigInt(row.id));
        }
        for (const issue of issues) {
          state.issues[issue]++;
          this.sql.exec("INSERT INTO legacy_archive_issues VALUES (?,?,?)", kind, row.rowid, issue);
        }
      }
      const end = rows.length < 100;
      state.complete = end && kind === legacyTables.length - 1;
      state.audit =
        end && !state.complete ? { kind: kind + 1, rowid: 0 } : { kind, rowid: rows.at(-1)?.rowid ?? rowid };
      this.save(state);
    });
    return { complete: this.state().complete, next: this.state().audit };
  }
  private audited() {
    const state = this.state();
    if (!state.complete) throw new Error("Frozen audit is incomplete");
    return state;
  }
  /** Bind the trusted operator cut to the independently collected complete expected set. */
  assertCut(cut: AdoptionCut): void {
    const state = this.audited();
    if (
      cut.sourceIdentity !== state.source.sourceIdentity ||
      cut.epoch !== state.source.epoch ||
      cut.drainEvidence !== state.source.drainEvidence ||
      cut.schemaVersion !== state.schemaVersion ||
      cut.mappings.length !== state.counts.threads ||
      cut.auditedUnthreaded + cut.mappings.length !== state.counts.conversations ||
      Object.values(state.issues).some((value) => value !== 0)
    )
      throw new Error("Cut does not match the complete frozen archive");
    for (const key of ["conversations", "threads", "posted", "derived", "responses"] as const)
      if (cut.sourceCounts[key] !== state.counts[key]) throw new Error("Cut source counts differ from frozen archive");
    const owners = new Set<string>();
    for (const mapping of cut.mappings) {
      const row = this.conversation({
        rowid: 0,
        account_id: mapping.accountId,
        conversation_id: mapping.conversationId,
      });
      const owner = `${mapping.accountId}:${mapping.conversationId}`;
      if (!row || owners.has(owner) || row.thread_id !== mapping.threadId || row.cursor !== mapping.cursor)
        throw new Error("Cut mapping differs from frozen expected set");
      const counts = (kind: number) =>
        this.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM legacy_archive_rows WHERE kind=? AND account_id=? AND conversation_id=?",
            kind,
            mapping.accountId,
            mapping.conversationId,
          )
          .one().n;
      const header = this.header(row, { posted: counts(1), derived: counts(2), responses: counts(3) });
      if (JSON.stringify(canonicalHeader(mapping.history.header)) !== JSON.stringify(header))
        throw new Error("Cut header differs from frozen receipt metadata");
      owners.add(owner);
    }
  }
  inventory(after = 0) {
    const state = this.audited();
    if (!safeCount.safeParse(after).success) throw new Error("Invalid inventory cursor");
    const rows = this.rows(0, after);
    return {
      source: state.source,
      sourceIdentity: state.source.sourceIdentity,
      schemaVersion: state.schemaVersion,
      mappings: rows.map((row) => ({
        rowid: row.rowid,
        accountId: row.account_id,
        conversationId: row.conversation_id,
        threadId: row.thread_id,
        cursor: row.cursor,
      })),
      next: rows.at(-1)?.rowid ?? after,
      complete: rows.length < 100,
      sourceCounts: state.counts,
      receiptAudit: state.issues,
      jobs: state.jobs,
      partial: state.partial,
      routingGuards: state.routingGuards,
      unknownGuards: state.unknownGuards,
      unknownCards: state.unknownCards,
      interactionFence: state.interactionFence,
    };
  }
  auditPage(after = { kind: 0, rowid: 0 }) {
    this.audited();
    if (!safeCount.safeParse(after.kind).success || after.kind > 6 || !safeCount.safeParse(after.rowid).success)
      throw new Error("Invalid audit cursor");
    // Page rows first so multiple diagnostics on the same source row cannot be skipped.
    const rows = this.sql
      .exec<{ kind: number; rowid: number }>(
        "SELECT DISTINCT kind,rowid FROM legacy_archive_issues WHERE kind>? OR (kind=? AND rowid>?) ORDER BY kind,rowid LIMIT 100",
        after.kind,
        after.kind,
        after.rowid,
      )
      .toArray();
    return {
      rows: rows.map((position) => {
        const row = this.sql
          .exec<{ account_id: number | null; conversation_id: number | null; message_id: number | null }>(
            "SELECT account_id,conversation_id,message_id FROM legacy_archive_rows WHERE kind=? AND rowid=?",
            position.kind,
            position.rowid,
          )
          .one();
        return {
          ...position,
          accountId: row.account_id,
          conversationId: row.conversation_id,
          messageId: row.message_id,
          issues: this.sql
            .exec<{ issue: string }>(
              "SELECT issue FROM legacy_archive_issues WHERE kind=? AND rowid=?",
              position.kind,
              position.rowid,
            )
            .toArray()
            .map((row) => row.issue),
        };
      }),
      next: rows.at(-1) ?? after,
      complete: rows.length < 100,
    };
  }
  async receiptPage(accountId: number, conversationId: number, position?: ReceiptPosition): Promise<ReceiptPage> {
    const state = this.audited();
    if (
      Object.values(state.issues).some((n) => n !== 0) ||
      state.jobs ||
      state.partial ||
      state.unknownCards ||
      state.unknownGuards
    )
      throw new Error("Frozen source has unresolved audit findings");
    if (![accountId, conversationId].every((id) => safeId.safeParse(id).success))
      throw new Error("Invalid receipt owner");
    const row = this.conversation({ rowid: 0, account_id: accountId, conversation_id: conversationId });
    if (!row) throw new Error("Missing authoritative legacy conversation");
    const count = (kind: number) =>
      this.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM legacy_archive_rows WHERE kind=? AND account_id=? AND conversation_id=?",
          kind,
          accountId,
          conversationId,
        )
        .one().n;
    const header = this.header(row, { posted: count(1), derived: count(2), responses: count(3) });
    const start = position ?? { index: 0, after: { kind: 0, rowid: 0 }, previous: await receiptHash(header) };
    if (
      !safeCount.safeParse(start.index).success ||
      !safeCount.safeParse(start.after.rowid).success ||
      !Number.isInteger(start.after.kind) ||
      start.after.kind < 0 ||
      start.after.kind > 2 ||
      !/^[a-f0-9]{64}$/.test(start.previous)
    )
      throw new Error("Invalid receipt cursor");
    const records: ReceiptPage["records"] = [];
    for (let kind = start.after.kind; kind < 3 && records.length <= 100; kind++) {
      const rows = this.sql
        .exec<{ value: string }>(
          "SELECT value FROM legacy_archive_rows WHERE kind=? AND account_id=? AND conversation_id=? AND rowid>? ORDER BY rowid LIMIT ?",
          kind + 1,
          accountId,
          conversationId,
          kind === start.after.kind ? start.after.rowid : 0,
          101 - records.length,
        )
        .toArray();
      records.push(...rows.map(({ value }) => this.record(JSON.parse(value), kind + 1)));
    }
    const complete = records.length <= 100;
    records.splice(100);
    const last = records.at(-1);
    const body = {
      header,
      index: start.index,
      after: start.after,
      next: last ? { kind: last.kind, rowid: last.rowid } : start.after,
      previous: start.previous,
      records,
      complete,
    };
    return validateReceiptPage({ ...body, digest: await receiptHash(receiptPageBody(body)) });
  }
}
