// Read-only cutover inventory; never returns cache values, bodies, or credentials.
export function legacyInventory(sql: SqlStorage, after = 0) {
  const schemaVersion = sql.exec<{ version: number }>("SELECT version FROM schema_version").one().version;
  if (![9, 10].includes(schemaVersion)) throw new Error("Unsupported legacy schema");
  const columns = sql.exec<{ name: string }>("PRAGMA table_info(conversations)").toArray();
  for (const name of ["account_id", "conversation_id", "thread_id", "cursor", "card_id"]) {
    if (!columns.some((column) => column.name === name)) throw new Error("Incomplete legacy schema");
  }
  const mappings = sql
    .exec<{ rowid: number; accountId: number; conversationId: number; threadId: string | null; cursor: number | null }>(
      "SELECT rowid, account_id AS accountId, conversation_id AS conversationId, thread_id AS threadId, cursor FROM conversations WHERE rowid > ? ORDER BY rowid LIMIT 100",
      after,
    )
    .toArray();
  const count = (query: string) => sql.exec<{ n: number }>(query).one().n;
  const interactions = sql.exec<{ id: string }>("SELECT id FROM interactions").toArray();
  const interactionFence = interactions.reduce(
    (max, row) => (/^\d+$/.test(row.id) && BigInt(row.id) > BigInt(max) ? row.id : max),
    "0",
  );
  const now = Date.now();
  // Only keys/counts are exposed: routing guards may contain bot credentials in their values.
  const keys = sql
    .exec<{ key: string }>("SELECT key FROM cache WHERE expires_at IS NULL OR expires_at > ?", now)
    .toArray()
    .map((row) => row.key);
  return {
    schemaVersion,
    mappings,
    next: mappings.at(-1)?.rowid ?? after,
    complete: mappings.length < 100,
    interactionFence,
    jobs: count("SELECT COUNT(*) AS n FROM jobs"),
    partial: count(
      "SELECT COUNT(*) AS n FROM posted_messages p LEFT JOIN conversations c ON c.account_id=p.account_id AND c.conversation_id=p.conversation_id WHERE c.cursor IS NULL OR p.message_id > c.cursor",
    ),
    routingGuards: keys.filter((key) => /^(route|kind-reply|kind-answered):/.test(key)).length,
    unknownGuards: count(
      "SELECT COUNT(*) AS n FROM cache WHERE (key LIKE 'send:%' AND value = 'unknown') OR (key LIKE 'effect:%' AND (value LIKE '%\"UNKNOWN\"%' OR value LIKE '%\"DISPATCHING\"%'))",
    ),
    // UNKNOWN card resources are reset by the authorized cleanup; message ambiguity blocks cutover.
    unknownCards: count("SELECT COUNT(*) AS n FROM conversations WHERE card_id LIKE '?%'"),
    responses: mappings.flatMap((mapping) =>
      sql
        .exec<{ accountId: number; conversationId: number; messageId: number; digest: string }>(
          "SELECT account_id AS accountId, conversation_id AS conversationId, message_id AS messageId, digest FROM submitted_responses WHERE account_id=? AND conversation_id=?",
          mapping.accountId,
          mapping.conversationId,
        )
        .toArray(),
    ),
  };
}
