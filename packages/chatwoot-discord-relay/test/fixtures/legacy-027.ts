// SQLite schema from relay 0.27.0 (b8aaf0b), retained for cutover compatibility tests.
export default `-- Schema from chatwoot-discord-relay 0.27.0 (b8aaf0b). No customer data.
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version VALUES (9);
CREATE TABLE conversations (
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
   CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE posted_messages (
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
   DELETE FROM deliveries;
CREATE TABLE submitted_responses (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     digest TEXT NOT NULL,
     PRIMARY KEY (account_id, conversation_id, message_id)
   );
ALTER TABLE conversations ADD COLUMN title_subject TEXT;
   ALTER TABLE conversations ADD COLUMN title TEXT;
   DROP TABLE IF EXISTS deliveries;
UPDATE conversations SET announced_assignee = NULL;
ALTER TABLE conversations ADD COLUMN announce_pending INTEGER;
CREATE TABLE interactions (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
CREATE TABLE derived_messages (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     discord_message_id TEXT NOT NULL,
     PRIMARY KEY (account_id, conversation_id, message_id, discord_message_id)
   );
   ALTER TABLE conversations ADD COLUMN title_message_id INTEGER;
ALTER TABLE conversations ADD COLUMN card_id TEXT;
   ALTER TABLE conversations ADD COLUMN card_covered INTEGER;
   ALTER TABLE conversations ADD COLUMN answer_id TEXT;
   ALTER TABLE conversations ADD COLUMN answer_source_id TEXT;
   ALTER TABLE conversations ADD COLUMN customer_message_id TEXT;
`;
