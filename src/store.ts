// Durable Object SQLite storage: conversation <-> post mappings, the job queue, webhook
// delivery dedupe, hourly counters, and a small cache.

import type { Cache } from "./discord/forum.js";
import type { RelayStore } from "./relay/relay.js";

const MIGRATIONS: string[] = [
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
];

const COUNTER_TTL_MS = 2 * 60 * 60 * 1000;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

export interface ConversationRow {
  threadId: string | undefined;
  state: string | undefined;
  /** Id of the last message handled; undefined for a mapping imported without one. */
  cursor: number | undefined;
  failMessageId: number | undefined;
  failCount: number;
}

export interface Job {
  key: string;
  payload: string;
  version: number;
  attempts: number;
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
      .exec<{
        thread_id: string | null;
        state: string | null;
        cursor: number | null;
        fail_message_id: number | null;
        fail_count: number;
      }>(
        "SELECT thread_id, state, cursor, fail_message_id, fail_count FROM conversations WHERE account_id = ? AND conversation_id = ?",
        accountId,
        conversationId,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      threadId: row.thread_id ?? undefined,
      state: row.state ?? undefined,
      cursor: row.cursor ?? undefined,
      failMessageId: row.fail_message_id ?? undefined,
      failCount: row.fail_count,
    };
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

  /** Maps a conversation to a post created elsewhere (e.g. by a previous relay). Returns false if the thread is taken. */
  adoptThread(accountId: number, conversationId: number, threadId: string): boolean {
    const owner = this.ticketForThread(threadId);
    if (owner && (owner.accountId !== accountId || owner.conversationId !== conversationId)) return false;
    this.sql.exec(
      `INSERT INTO conversations (account_id, conversation_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT (account_id, conversation_id) DO UPDATE SET thread_id = excluded.thread_id, state = NULL`,
      accountId,
      conversationId,
      threadId,
    );
    return true;
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

  forgetThread(accountId: number, conversationId: number): void {
    this.sql.exec(
      "UPDATE conversations SET thread_id = NULL, state = NULL WHERE account_id = ? AND conversation_id = ?",
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

  // Webhook deliveries

  /** False when this delivery id was already seen. */
  recordDelivery(id: string): boolean {
    return (
      this.sql.exec("INSERT INTO deliveries (id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING", id, this.now())
        .rowsWritten > 0
    );
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
    return this.sql
      .exec<{ key: string; payload: string; version: number; attempts: number }>(
        "SELECT key, payload, version, attempts FROM jobs WHERE not_before <= ? ORDER BY priority, not_before, created_at LIMIT 1",
        this.now(),
      )
      .toArray()[0];
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
    this.sql.exec("DELETE FROM deliveries WHERE received_at <= ?", now - DELIVERY_TTL_MS);
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
