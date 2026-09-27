// Durable Object SQLite storage: conversation <-> post mappings, the Discord messages posted
// for each Chatwoot message, the job queue, hourly counters, and a small cache.

import type { Cache } from "./discord/forum.js";
import type { RelayStore } from "./relay/relay.js";

export const MIGRATIONS: string[] = [
  `CREATE TABLE conversations (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     thread_id TEXT,
     state TEXT,
     cursor INTEGER,
     fail_message_id INTEGER,
     fail_count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (account_id, conversation_id)
   );
   CREATE UNIQUE INDEX conversations_thread ON conversations (thread_id);
   CREATE TABLE jobs (
     key TEXT PRIMARY KEY,
     priority INTEGER NOT NULL,
     payload TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     attempts INTEGER NOT NULL DEFAULT 0,
     not_before INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX jobs_due ON jobs (not_before);
   CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
   CREATE TABLE counters (name TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);`,
  // posted_messages checkpoints relaying (a retry resumes after the parts already posted) and
  // finds the Discord messages to delete when a message is deleted in Chatwoot.
  // announced_assignee starts from the assignee field of the stored state, which was used for
  // this before. Webhook deliveries are no longer deduplicated; the table is emptied but kept so
  // that a previous version still runs if it is deployed again.
  `CREATE TABLE posted_messages (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     part INTEGER NOT NULL,
     discord_message_id TEXT NOT NULL,
     PRIMARY KEY (account_id, conversation_id, message_id, part)
   );
   ALTER TABLE conversations ADD COLUMN announced_assignee TEXT;
   UPDATE conversations
     SET announced_assignee = substr(substr(state, instr(state, '|') + 1), 1, instr(substr(state, instr(state, '|') + 1), '|') - 1)
     WHERE state LIKE '%|%|%';
   DELETE FROM deliveries;`,
];

const COUNTER_TTL_MS = 2 * 60 * 60 * 1000;

export interface ConversationRow {
  threadId: string | undefined;
  state: string | undefined;
  /** Id of the last message handled; undefined for an adopted post until its first run. */
  cursor: number | undefined;
}

export interface Job {
  key: string;
  payload: string;
  version: number;
  attempts: number;
  /** When the job was first queued (ms since the epoch). */
  createdAt: number;
}

export class Store implements RelayStore, Cache {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number = Date.now,
  ) {}

  migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0];
    let version = row?.version ?? 0;
    if (!row) this.sql.exec("INSERT INTO schema_version (version) VALUES (0)");
    for (; version < MIGRATIONS.length; version += 1) {
      this.sql.exec(MIGRATIONS[version] ?? "");
      this.sql.exec("UPDATE schema_version SET version = ?", version + 1);
    }
  }

  // Conversations

  conversation(accountId: number, conversationId: number): ConversationRow | undefined {
    const row = this.sql
      .exec<{ thread_id: string | null; state: string | null; cursor: number | null }>(
        "SELECT thread_id, state, cursor FROM conversations WHERE account_id = ? AND conversation_id = ?",
        accountId,
        conversationId,
      )
      .toArray()[0];
    if (!row) return undefined;
    return { threadId: row.thread_id ?? undefined, state: row.state ?? undefined, cursor: row.cursor ?? undefined };
  }

  ticketForThread(threadId: string): { accountId: number; conversationId: number } | undefined {
    const row = this.sql
      .exec<{ account_id: number; conversation_id: number }>(
        "SELECT account_id, conversation_id FROM conversations WHERE thread_id = ?",
        threadId,
      )
      .toArray()[0];
    return row ? { accountId: row.account_id, conversationId: row.conversation_id } : undefined;
  }

  setCursor(accountId: number, conversationId: number, cursor: number): void {
    this.ensureRow(accountId, conversationId);
    this.sql.exec(
      "UPDATE conversations SET cursor = ?, fail_message_id = NULL, fail_count = 0 WHERE account_id = ? AND conversation_id = ?",
      cursor,
      accountId,
      conversationId,
    );
  }

  /** Records a failed attempt at relaying `messageId` and returns the attempt count. */
  recordFailure(accountId: number, conversationId: number, messageId: number): number {
    this.ensureRow(accountId, conversationId);
    const row = this.sql
      .exec<{ fail_count: number }>(
        `UPDATE conversations
           SET fail_count = CASE WHEN fail_message_id = ?1 THEN fail_count + 1 ELSE 1 END, fail_message_id = ?1
         WHERE account_id = ?2 AND conversation_id = ?3 RETURNING fail_count`,
        messageId,
        accountId,
        conversationId,
      )
      .toArray()[0];
    return row?.fail_count ?? 1;
  }

  /** Maps a conversation to an existing post that no other conversation is mapped to. */
  adoptThread(accountId: number, conversationId: number, threadId: string): void {
    this.sql.exec(
      `INSERT INTO conversations (account_id, conversation_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT (account_id, conversation_id) DO UPDATE SET thread_id = excluded.thread_id, state = NULL`,
      accountId,
      conversationId,
      threadId,
    );
  }

  // RelayStore

  thread(accountId: number, conversationId: number): string | undefined {
    return this.conversation(accountId, conversationId)?.threadId;
  }

  saveThread(accountId: number, conversationId: number, threadId: string): void {
    this.ensureRow(accountId, conversationId);
    this.sql.exec(
      "UPDATE conversations SET thread_id = ? WHERE account_id = ? AND conversation_id = ?",
      threadId,
      accountId,
      conversationId,
    );
  }

  state(accountId: number, conversationId: number): string | undefined {
    return this.conversation(accountId, conversationId)?.state;
  }

  saveState(accountId: number, conversationId: number, state: string): void {
    this.ensureRow(accountId, conversationId);
    this.sql.exec(
      "UPDATE conversations SET state = ? WHERE account_id = ? AND conversation_id = ?",
      state,
      accountId,
      conversationId,
    );
  }

  announcedAssignee(accountId: number, conversationId: number): string | undefined {
    const row = this.sql
      .exec<{ announced_assignee: string | null }>(
        "SELECT announced_assignee FROM conversations WHERE account_id = ? AND conversation_id = ?",
        accountId,
        conversationId,
      )
      .toArray()[0];
    return row?.announced_assignee ?? undefined;
  }

  saveAnnouncedAssignee(accountId: number, conversationId: number, assignee: string): void {
    this.ensureRow(accountId, conversationId);
    this.sql.exec(
      "UPDATE conversations SET announced_assignee = ? WHERE account_id = ? AND conversation_id = ?",
      assignee,
      accountId,
      conversationId,
    );
  }

  postedParts(accountId: number, conversationId: number, messageId: number): string[] {
    return this.sql
      .exec<{ discord_message_id: string }>(
        "SELECT discord_message_id FROM posted_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ? ORDER BY part",
        accountId,
        conversationId,
        messageId,
      )
      .toArray()
      .map((row) => row.discord_message_id);
  }

  savePostedPart(accountId: number, conversationId: number, messageId: number, part: number, discordId: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO posted_messages (account_id, conversation_id, message_id, part, discord_message_id) VALUES (?, ?, ?, ?, ?)",
      accountId,
      conversationId,
      messageId,
      part,
      discordId,
    );
  }

  deletePostedPart(accountId: number, conversationId: number, messageId: number, discordId: string): void {
    this.sql.exec(
      "DELETE FROM posted_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ? AND discord_message_id = ?",
      accountId,
      conversationId,
      messageId,
      discordId,
    );
  }

  forgetThread(accountId: number, conversationId: number): void {
    this.sql.exec(
      "UPDATE conversations SET thread_id = NULL, state = NULL, announced_assignee = NULL WHERE account_id = ? AND conversation_id = ?",
      accountId,
      conversationId,
    );
    this.sql.exec(
      "DELETE FROM posted_messages WHERE account_id = ? AND conversation_id = ?",
      accountId,
      conversationId,
    );
  }

  firstAttempt(name: string): boolean {
    const expiresAt = this.now() + COUNTER_TTL_MS;
    const inserted = this.sql.exec(
      "INSERT INTO counters (name, count, expires_at) VALUES (?, 1, ?) ON CONFLICT (name) DO NOTHING",
      name,
      expiresAt,
    );
    return inserted.rowsWritten > 0;
  }

  increment(name: string): number {
    const row = this.sql
      .exec<{ count: number }>(
        `INSERT INTO counters (name, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT (name) DO UPDATE SET count = count + 1 RETURNING count`,
        name,
        this.now() + COUNTER_TTL_MS,
      )
      .toArray()[0];
    return row?.count ?? 1;
  }

  // Cache

  get(key: string): string | undefined {
    const row = this.sql
      .exec<{ value: string; expires_at: number | null }>("SELECT value, expires_at FROM cache WHERE key = ?", key)
      .toArray()[0];
    if (!row || (row.expires_at !== null && row.expires_at <= this.now())) return undefined;
    return row.value;
  }

  set(key: string, value: string, ttlMs?: number): void {
    this.sql.exec(
      "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      key,
      value,
      ttlMs === undefined ? null : this.now() + ttlMs,
    );
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM cache WHERE key = ?", key);
  }

  // Jobs

  /**
   * Adds a job, or marks an existing one as needing another run (its version changes). A job
   * that is backing off after failures keeps its schedule.
   */
  enqueue(key: string, priority: number, payload: string, notBefore = this.now()): void {
    this.sql.exec(
      `INSERT INTO jobs (key, priority, payload, not_before, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET version = version + 1, payload = excluded.payload,
         not_before = CASE WHEN attempts > 0 THEN not_before ELSE MIN(not_before, excluded.not_before) END`,
      key,
      priority,
      payload,
      notBefore,
      this.now(),
    );
  }

  nextDueJob(): Job | undefined {
    const row = this.sql
      .exec<{ key: string; payload: string; version: number; attempts: number; created_at: number }>(
        "SELECT key, payload, version, attempts, created_at FROM jobs WHERE not_before <= ? ORDER BY priority, not_before, created_at LIMIT 1",
        this.now(),
      )
      .toArray()[0];
    if (!row) return undefined;
    const { created_at: createdAt, ...job } = row;
    return { ...job, createdAt };
  }

  /** Earliest time any job is due, if there are jobs. */
  nextWakeup(): number | undefined {
    const row = this.sql.exec<{ at: number | null }>("SELECT MIN(not_before) AS at FROM jobs").toArray()[0];
    return row?.at ?? undefined;
  }

  /** Removes a finished job unless it was enqueued again while running. */
  completeJob(job: Job): void {
    const removed = this.sql.exec("DELETE FROM jobs WHERE key = ? AND version = ?", job.key, job.version).rowsWritten;
    if (removed === 0) this.sql.exec("UPDATE jobs SET attempts = 0, not_before = ? WHERE key = ?", this.now(), job.key);
  }

  deleteJob(key: string): void {
    this.sql.exec("DELETE FROM jobs WHERE key = ?", key);
  }

  retryJob(job: Job, delayMs: number): void {
    this.sql.exec(
      "UPDATE jobs SET attempts = attempts + 1, not_before = ? WHERE key = ?",
      this.now() + delayMs,
      job.key,
    );
  }

  /** Makes a job due now without counting an attempt (used when an invocation runs out of budget). */
  deferJob(job: Job): void {
    this.sql.exec("UPDATE jobs SET not_before = ? WHERE key = ?", this.now(), job.key);
  }

  prune(): void {
    const now = this.now();
    this.sql.exec("DELETE FROM counters WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
  }

  private ensureRow(accountId: number, conversationId: number): void {
    this.sql.exec(
      "INSERT INTO conversations (account_id, conversation_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      accountId,
      conversationId,
    );
  }
}
