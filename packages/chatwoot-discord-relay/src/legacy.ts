// Source-only frozen reads. Never instantiate Store, alter source tables, or log private rows.
import { z } from "zod";
import { receiptHash } from "./history.ts";
import { escalationsSchema } from "./queue.ts";

export const frozenSourceSchema = z.strictObject({
  sourceIdentity: z.string().min(1).max(256),
  epoch: z.string().min(1).max(256),
  drainEvidence: z.string().min(1).max(256),
  frozen: z.literal(true),
});
export type FrozenSource = z.infer<typeof frozenSourceSchema>;
export const legacyTables = [
  "conversations",
  "posted_messages",
  "derived_messages",
  "submitted_responses",
  "cache",
  "jobs",
  "interactions",
] as const;
export interface LegacyPosition {
  kind: number;
  rowid: number;
}
export type LegacyRow = Record<string, string | number | null> & { rowid: number };
export interface LegacyScanPage {
  source: FrozenSource;
  schemaVersion: 9 | 10;
  after: LegacyPosition;
  next: LegacyPosition;
  rows: LegacyRow[];
  complete: boolean;
  digest: string;
}
export function validateFrozenSource(input: unknown): FrozenSource {
  const result = frozenSourceSchema.safeParse(input);
  if (!result.success) throw new Error("A settled, frozen source boundary is required");
  return result.data;
}
function schema(sql: SqlStorage): 9 | 10 {
  const version = sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version;
  if (version !== 9 && version !== 10) throw new Error("Unsupported legacy schema");
  const supported = new Set(["schema_version", ...legacyTables, "counters"]);
  const tables = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)!='sqlite_' AND substr(name,1,4)!='_cf_' LIMIT 33",
    )
    .toArray();
  if (tables.length > 32 || tables.some(({ name }) => !supported.has(name)))
    throw new Error("Unsupported legacy table");
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
      .map(({ name }) => name);
    if (actual.length !== columns.length || columns.some((column) => !actual.includes(column)))
      throw new Error("Unsupported or incomplete legacy receipt schema");
  }
  return version;
}
// Byte length is checked inside SQLite before copying TEXT into JS/RPC. An overlong value
// becomes NULL plus a diagnostic flag; it is never silently accepted as absent metadata.
const text = (column: string, bytes: number) =>
  `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${bytes} THEN ${column} END AS ${column}`;
const invalidText = (column: string, bytes: number) =>
  `(${column} IS NOT NULL AND (typeof(${column})!='text' OR length(CAST(${column} AS BLOB))>${bytes}))`;
const numeric = (column: string) => `CASE WHEN typeof(${column}) IN ('integer','real') THEN ${column} END AS ${column}`;
const owner = `${numeric("account_id")},${numeric("conversation_id")}`;
const selections = [
  `${owner},${numeric("cursor")},${numeric("title_message_id")},${text("thread_id", 20)},${text("title_subject", 4096)},${text("title", 4096)},(${invalidText("thread_id", 20)} OR ${invalidText("title_subject", 4096)} OR ${invalidText("title", 4096)}) AS invalid_text,(cursor IS NOT NULL AND typeof(cursor) NOT IN ('integer','real')) OR (title_message_id IS NOT NULL AND typeof(title_message_id) NOT IN ('integer','real')) AS invalid_numeric,CASE WHEN substr(card_id,1,1)='?' THEN 1 ELSE 0 END AS unknown_card`,
  `${owner},${numeric("message_id")},${numeric("part")},${text("discord_message_id", 20)},${invalidText("discord_message_id", 20)} AS invalid_text`,
  `${owner},${numeric("message_id")},${text("discord_message_id", 20)},${invalidText("discord_message_id", 20)} AS invalid_text`,
  `${owner},${numeric("message_id")},${text("digest", 64)},${invalidText("digest", 64)} AS invalid_text`,
  `${text("key", 4096)},${invalidText("key", 4096)} AS invalid_text,CASE WHEN length(CAST(value AS BLOB))>16384 AND (key GLOB 'send:*' OR key GLOB 'effect:*') THEN 1 ELSE 0 END AS oversized_guard,
   CASE WHEN length(CAST(value AS BLOB))<=16384 AND ((key GLOB 'send:*' AND value='unknown') OR (key GLOB 'effect:*' AND (value LIKE '%"UNKNOWN"%' OR value LIKE '%"DISPATCHING"%'))) THEN 1 ELSE 0 END AS unknown_guard`,
  "1 AS job",
  `${text("id", 20)},${invalidText("id", 20)} AS invalid_text`,
];

/** One indexed rowid range from ONE table, with no joins, counts, sorts or global audits.
 * The serving shell must fence every writer before calling this function. A caller timeout
 * is not SQLite cancellation. Complete the empty terminal page of all seven tables.
 */
export async function legacyScanPage(
  sql: SqlStorage,
  source: FrozenSource,
  after: LegacyPosition = { kind: 0, rowid: 0 },
): Promise<LegacyScanPage> {
  source = validateFrozenSource(source);
  if (
    !Number.isSafeInteger(after.kind) ||
    after.kind < 0 ||
    after.kind >= legacyTables.length ||
    !Number.isSafeInteger(after.rowid) ||
    after.rowid < 0
  )
    throw new Error("Invalid legacy scan cursor");
  const schemaVersion = schema(sql);
  const table = legacyTables[after.kind];
  const selection = selections[after.kind];
  if (!table || !selection) throw new Error("Invalid legacy table");
  if (
    after.rowid === 0 &&
    (sql.exec(`SELECT 1 FROM ${table} WHERE rowid<=0 LIMIT 1`).toArray().length ||
      sql.exec(`SELECT 1 FROM ${table} WHERE rowid>9007199254740991 LIMIT 1`).toArray().length)
  )
    throw new Error(`Unsupported legacy rowid in table ${table}`);
  const rows = sql
    .exec<LegacyRow>(`SELECT rowid,${selection} FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 100`, after.rowid)
    .toArray();
  const last = rows.at(-1);
  const end = rows.length < 100;
  const complete = end && after.kind === legacyTables.length - 1;
  const next =
    end && !complete ? { kind: after.kind + 1, rowid: 0 } : { kind: after.kind, rowid: last?.rowid ?? after.rowid };
  const body = { source, schemaVersion, after, next, rows, complete };
  return { ...body, digest: await receiptHash(body) };
}

/** Only this named numeric coordination baseline may leave cache; never arbitrary values. */
export function legacyEscalationBaseline(sql: SqlStorage, source: FrozenSource): string {
  validateFrozenSource(source);
  schema(sql);
  const row = sql
    .exec<{ value: string | null }>(
      "SELECT CASE WHEN length(CAST(value AS BLOB))<=1048576 THEN value END AS value FROM cache WHERE key='queue:escalations'",
    )
    .toArray()[0];
  if (row && row.value === null) throw new Error("Legacy escalation baseline exceeds the private export bound");
  let input: unknown;
  try {
    input = JSON.parse(row?.value ?? "{}");
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
