// Source-only, bounded SQLite reads. Headers contain private titles; never log their values.
import {
  canonicalHeader,
  type ReceiptHeader,
  type ReceiptPage,
  type ReceiptPosition,
  receiptHash,
  receiptHeaderSchema,
  receiptPageBody,
  receiptPageSchema,
  validateReceiptPage,
  validateTitleMetadata,
} from "./history.ts";
import { escalationsSchema } from "./queue.ts";

function schema(sql: SqlStorage): 9 | 10 {
  const version = sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version;
  if (version !== 9 && version !== 10) throw new Error("Unsupported legacy schema");
  const tables = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)!='sqlite_' AND substr(name,1,4)!='_cf_'",
    )
    .toArray();
  const supported = new Set([
    "schema_version",
    "conversations",
    "jobs",
    "counters",
    "cache",
    "posted_messages",
    "derived_messages",
    "submitted_responses",
    "interactions",
  ]);
  if (tables.some((table) => !supported.has(table.name))) throw new Error("Unsupported legacy table");
  const expected = {
    conversations: [
      "account_id",
      "conversation_id",
      "thread_id",
      "state",
      "cursor",
      "fail_message_id",
      "fail_count",
      "announced_assignee",
      "announce_pending",
      "title_subject",
      "title",
      "title_message_id",
      "card_id",
      "card_covered",
      "answer_id",
      "answer_source_id",
      "customer_message_id",
      ...(version === 10 ? ["assignee_notice_id"] : []),
    ],
    posted_messages: ["account_id", "conversation_id", "message_id", "part", "discord_message_id"],
    derived_messages: ["account_id", "conversation_id", "message_id", "discord_message_id"],
    submitted_responses: ["account_id", "conversation_id", "message_id", "digest"],
  };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((row) => row.name);
    if (actual.length !== columns.length || columns.some((column) => !actual.includes(column)))
      throw new Error("Unsupported or incomplete legacy receipt schema");
  }
  return version;
}
const RECEIPTS = `SELECT 0 AS kind,rowid,account_id,conversation_id,message_id,part,discord_message_id,NULL AS digest FROM posted_messages
 UNION ALL SELECT 1,rowid,account_id,conversation_id,message_id,NULL,discord_message_id,NULL FROM derived_messages
 UNION ALL SELECT 2,rowid,account_id,conversation_id,message_id,NULL,NULL,digest FROM submitted_responses`;
const UNKNOWN_KEY = `key NOT GLOB 'forum:*:guild' AND key NOT GLOB 'forum:*:webhook' AND key != 'discord:application'
 AND key NOT GLOB 'answer:*' AND key NOT GLOB 'sweep:*:last' AND key NOT GLOB 'sweep:*:pass'
 AND key NOT GLOB 'inbox:*' AND key NOT GLOB 'avatar:*' AND key NOT GLOB 'triage:*'
 AND key NOT GLOB 'card-backfill:*' AND key != 'queue:escalations'
 AND key NOT GLOB 'route:*' AND key NOT GLOB 'kind-reply:*' AND key NOT GLOB 'kind-answered:*'`;
const ISSUES = `WITH receipts AS (${RECEIPTS}), repeated AS (
 SELECT discord_message_id FROM receipts WHERE discord_message_id IS NOT NULL GROUP BY discord_message_id HAVING COUNT(*) > 1
 ) SELECT r.kind,r.rowid,r.account_id AS accountId,r.conversation_id AS conversationId,r.message_id AS messageId,
 CASE WHEN c.thread_id IS NULL THEN 'orphaned'
 WHEN r.discord_message_id IN (SELECT discord_message_id FROM repeated) THEN 'conflicting'
 ELSE 'invalid' END AS issue
 FROM receipts r LEFT JOIN conversations c ON c.account_id=r.account_id AND c.conversation_id=r.conversation_id
 WHERE c.thread_id IS NULL OR r.discord_message_id IN (SELECT discord_message_id FROM repeated)
 OR r.account_id<=0 OR r.conversation_id<=0 OR r.message_id<=0 OR r.message_id>9007199254740991 OR c.cursor IS NULL OR r.message_id>c.cursor
 OR (r.kind=0 AND (r.part<0 OR typeof(r.part)!='integer'))
 OR (r.kind<2 AND (length(r.discord_message_id) NOT BETWEEN 17 AND 20 OR r.discord_message_id GLOB '*[^0-9]*'))
 OR (r.kind=1 AND NOT EXISTS (SELECT 1 FROM submitted_responses s WHERE s.account_id=r.account_id AND s.conversation_id=r.conversation_id AND s.message_id=r.message_id))
 OR (r.kind=2 AND (length(r.digest)!=64 OR r.digest GLOB '*[^a-f0-9]*' OR NOT EXISTS (SELECT 1 FROM derived_messages d WHERE d.account_id=r.account_id AND d.conversation_id=r.conversation_id AND d.message_id=r.message_id)))
 UNION ALL SELECT 3,c.rowid,c.account_id,c.conversation_id,COALESCE(c.title_message_id,0),
 CASE WHEN c.thread_id IS NULL THEN 'orphaned' ELSE 'invalid' END
 FROM conversations c WHERE
 (c.thread_id IS NULL AND (c.title_subject IS NOT NULL OR c.title IS NOT NULL OR c.title_message_id IS NOT NULL))
 OR (c.title_subject IS NULL)!=(c.title IS NULL)
 OR (c.title_message_id IS NOT NULL AND c.title_subject IS NULL)
 OR c.title_message_id>c.cursor
 OR (c.title_subject IS NOT NULL AND c.title_subject!='' AND (c.title_message_id IS NULL OR NOT EXISTS (
 SELECT 1 FROM posted_messages p WHERE p.account_id=c.account_id AND p.conversation_id=c.conversation_id AND p.message_id=c.title_message_id)))`;

export function legacyAuditPage(sql: SqlStorage, after = { kind: 0, rowid: 0 }) {
  schema(sql);
  if (
    !Number.isSafeInteger(after.kind) ||
    after.kind < 0 ||
    after.kind > 3 ||
    !Number.isSafeInteger(after.rowid) ||
    after.rowid < 0
  )
    throw new Error("Invalid legacy audit cursor");
  const rows = sql
    .exec<{ kind: number; rowid: number; accountId: number; conversationId: number; messageId: number; issue: string }>(
      `SELECT * FROM (${ISSUES}) WHERE kind>? OR (kind=? AND rowid>?) ORDER BY kind,rowid LIMIT 100`,
      after.kind,
      after.kind,
      after.rowid,
    )
    .toArray();
  const last = rows.at(-1);
  return { rows, next: last ? { kind: last.kind, rowid: last.rowid } : after, complete: rows.length < 100 };
}
export function legacyKeyPage(sql: SqlStorage, after = "") {
  schema(sql);
  if (typeof after !== "string" || after.length > 4096) throw new Error("Invalid legacy key cursor");
  const rows = sql
    .exec<{ key: string; unsupported: number }>(
      `SELECT key, CASE WHEN ${UNKNOWN_KEY} THEN 1 ELSE 0 END AS unsupported FROM cache WHERE key>? ORDER BY key LIMIT 100`,
      after,
    )
    .toArray();
  return { rows, next: rows.at(-1)?.key ?? after, complete: rows.length < 100 };
}
export function legacyInventory(sql: SqlStorage, after = 0) {
  const schemaVersion = schema(sql);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid legacy inventory cursor");
  const mappings = sql
    .exec<{ rowid: number; accountId: number; conversationId: number; threadId: string | null; cursor: number | null }>(
      "SELECT rowid,account_id AS accountId,conversation_id AS conversationId,thread_id AS threadId,cursor FROM conversations WHERE rowid>? ORDER BY rowid LIMIT 100",
      after,
    )
    .toArray();
  const count = (query: string) => sql.exec<{ n: number }>(query).one().n;
  const interactionFence =
    sql
      .exec<{ id: string }>(
        "SELECT id FROM interactions WHERE id!='' AND id NOT GLOB '*[^0-9]*' ORDER BY length(ltrim(id,'0')) DESC,ltrim(id,'0') DESC LIMIT 1",
      )
      .toArray()[0]?.id ?? "0";
  return {
    schemaVersion,
    mappings,
    next: mappings.at(-1)?.rowid ?? after,
    complete: mappings.length < 100,
    interactionFence,
    jobs: count("SELECT COUNT(*) AS n FROM jobs"),
    partial: count(
      "SELECT COUNT(*) AS n FROM posted_messages p LEFT JOIN conversations c ON c.account_id=p.account_id AND c.conversation_id=p.conversation_id WHERE c.cursor IS NULL OR p.message_id>c.cursor",
    ),
    routingGuards: count(
      "SELECT COUNT(*) AS n FROM cache WHERE key GLOB 'route:*' OR key GLOB 'kind-reply:*' OR key GLOB 'kind-answered:*'",
    ),
    unknownGuards: count(
      "SELECT COUNT(*) AS n FROM cache WHERE (key LIKE 'send:%' AND value='unknown') OR (key LIKE 'effect:%' AND (value LIKE '%\"UNKNOWN\"%' OR value LIKE '%\"DISPATCHING\"%'))",
    ),
    unknownCards: count("SELECT COUNT(*) AS n FROM conversations WHERE card_id LIKE '?%'"),
    sourceCounts: {
      conversations: count("SELECT COUNT(*) AS n FROM conversations"),
      threads: count("SELECT COUNT(*) AS n FROM conversations WHERE thread_id IS NOT NULL"),
      posted: count("SELECT COUNT(*) AS n FROM posted_messages"),
      derived: count("SELECT COUNT(*) AS n FROM derived_messages"),
      responses: count("SELECT COUNT(*) AS n FROM submitted_responses"),
    },
    receiptAudit: {
      orphaned: count(`SELECT COUNT(*) AS n FROM (${ISSUES}) WHERE issue='orphaned'`),
      conflicting: count(`SELECT COUNT(*) AS n FROM (${ISSUES}) WHERE issue='conflicting'`),
      invalid:
        count(`SELECT COUNT(*) AS n FROM (${ISSUES}) WHERE issue='invalid'`) +
        count("SELECT COUNT(*) AS n FROM interactions WHERE id='' OR id GLOB '*[^0-9]*'"),
      unsupported: count(`SELECT COUNT(*) AS n FROM cache WHERE ${UNKNOWN_KEY}`),
    },
  };
}

/** A frozen schema9/10 source returns at most 100 receipts, never nested conversation histories. */
export async function legacyReceiptPage(
  sql: SqlStorage,
  sourceIdentity: string,
  accountId: number,
  conversationId: number,
  position?: ReceiptPosition,
): Promise<ReceiptPage> {
  const schemaVersion = schema(sql);
  if (
    !Number.isSafeInteger(accountId) ||
    accountId <= 0 ||
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0
  )
    throw new Error("Invalid legacy receipt owner");
  const raw = sql
    .exec<Omit<ReceiptHeader, "sourceIdentity" | "schemaVersion" | "counts">>(
      `SELECT account_id AS accountId,conversation_id AS conversationId,thread_id AS threadId,cursor,
    title_subject AS titleSubject,title,title_message_id AS titleMessageId FROM conversations WHERE account_id=? AND conversation_id=?`,
      accountId,
      conversationId,
    )
    .toArray()[0];
  if (!raw) throw new Error("Missing authoritative legacy conversation");
  const counts = (table: string) =>
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE account_id=? AND conversation_id=?`,
        accountId,
        conversationId,
      )
      .one().n;
  const parsed = receiptHeaderSchema.safeParse({
    ...raw,
    sourceIdentity,
    schemaVersion,
    counts: {
      posted: counts("posted_messages"),
      derived: counts("derived_messages"),
      responses: counts("submitted_responses"),
    },
  });
  if (!parsed.success) throw new Error("Invalid or unprocessed authoritative legacy metadata");
  const header = canonicalHeader(parsed.data);
  validateTitleMetadata(header);
  if (
    header.titleSubject &&
    !sql
      .exec(
        "SELECT 1 FROM posted_messages WHERE account_id=? AND conversation_id=? AND message_id=? LIMIT 1",
        accountId,
        conversationId,
        header.titleMessageId,
      )
      .toArray().length
  )
    throw new Error("Missing authoritative legacy title receipt");
  const start = position ?? { index: 0, after: { kind: 0, rowid: 0 }, previous: await receiptHash(header) };
  if (
    !Number.isSafeInteger(start.index) ||
    start.index < 0 ||
    !Number.isSafeInteger(start.after.kind) ||
    start.after.kind < 0 ||
    start.after.kind > 2 ||
    !Number.isSafeInteger(start.after.rowid) ||
    start.after.rowid < 0 ||
    !/^[a-f0-9]{64}$/.test(start.previous)
  )
    throw new Error("Invalid legacy receipt cursor");
  const rows = sql
    .exec<{
      kind: 0 | 1 | 2;
      rowid: number;
      message_id: number;
      part: number | null;
      discord_message_id: string | null;
      digest: string | null;
    }>(
      `SELECT * FROM (${RECEIPTS}) WHERE account_id=? AND conversation_id=? AND (kind>? OR (kind=? AND rowid>?)) ORDER BY kind,rowid LIMIT 101`,
      accountId,
      conversationId,
      start.after.kind,
      start.after.kind,
      start.after.rowid,
    )
    .toArray();
  const records = rows.slice(0, 100).map((row) => {
    const base = { rowid: row.rowid, messageId: row.message_id };
    if (row.kind === 0) return { ...base, kind: 0 as const, part: row.part, discordId: row.discord_message_id };
    if (row.kind === 1) return { ...base, kind: 1 as const, discordId: row.discord_message_id };
    return { ...base, kind: 2 as const, digest: row.digest };
  });
  const last = records.at(-1);
  const body = {
    header,
    index: start.index,
    after: start.after,
    next: last ? { kind: last.kind, rowid: last.rowid } : start.after,
    previous: start.previous,
    records,
    complete: rows.length <= 100,
  };
  // The source rejects malformed rows rather than silently omitting them.
  const candidate = receiptPageSchema.safeParse({ ...body, digest: "0".repeat(64) });
  if (!candidate.success) throw new Error("Invalid authoritative legacy receipt");
  const page = candidate.data;
  return validateReceiptPage({ ...page, digest: await receiptHash(receiptPageBody(page)) });
}

/** Only this named numeric coordination baseline may leave cache; no arbitrary cache reader. */
export function legacyEscalationBaseline(sql: SqlStorage): string {
  schema(sql);
  const value =
    sql.exec<{ value: string }>("SELECT value FROM cache WHERE key='queue:escalations'").toArray()[0]?.value ?? "{}";
  if (value.length > 1024 * 1024) throw new Error("Legacy escalation baseline exceeds the private export bound");
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error("Invalid legacy escalation baseline");
  }
  const parsed = escalationsSchema.safeParse(input);
  if (
    !parsed.success ||
    Object.entries(parsed.data).some(
      ([key, state]) =>
        !/^\d+:\d+$/.test(key) ||
        !Number.isFinite(state.since) ||
        state.since < 0 ||
        !Number.isSafeInteger(state.level) ||
        state.level < 0,
    )
  )
    throw new Error("Invalid legacy escalation baseline");
  return JSON.stringify(Object.fromEntries(Object.entries(parsed.data).sort(([a], [b]) => a.localeCompare(b))));
}
