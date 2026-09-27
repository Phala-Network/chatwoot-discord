// Optional cutover fallback: loads existing conversation -> post mappings into a running
// deployment, so no second post is opened for a conversation that already has one. Usually not
// needed: posts linked through the conversation's `discord_thread` attribute are recovered
// automatically. Input is JSON lines: {"accountId": 1, "conversationId": 12, "threadId": "...",
// "lastMessageId": 345} (lastMessageId optional).
//
//   ADMIN_TOKEN=... pnpm import-state --url https://relay.example.com --file mappings.jsonl \
//     [--after-message-id <id>]
//
// --after-message-id applies to lines without lastMessageId: messages after it are relayed into
// the imported post. Remove the ADMIN_TOKEN secret afterwards to disable the endpoint.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const BATCH = 500;

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    file: { type: "string" },
    "after-message-id": { type: "string" },
  },
});
const token = process.env.ADMIN_TOKEN;
const after = values["after-message-id"] === undefined ? undefined : Number(values["after-message-id"]);

if (!token || !values.url || !values.file || (after !== undefined && !Number.isSafeInteger(after))) {
  console.error(
    "Usage: ADMIN_TOKEN=... pnpm import-state --url <worker url> --file <mappings.jsonl> [--after-message-id <id>]",
  );
  process.exit(2);
}

const endpoint = new URL("/admin/import", values.url);
if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
  console.error("Refusing to send the admin token over plain HTTP.");
  process.exit(2);
}

const lines = (await readFile(values.file, "utf8")).split("\n").filter((line) => line.trim() !== "");
const withCursor = lines.map((line) => {
  if (after === undefined) return line;
  try {
    const row: unknown = JSON.parse(line);
    if (typeof row === "object" && row !== null && !("lastMessageId" in row)) {
      return JSON.stringify({ ...row, lastMessageId: after });
    }
  } catch {
    // Sent as-is; the endpoint reports it as invalid.
  }
  return line;
});

let imported = 0;
let skipped = 0;
for (let start = 0; start < withCursor.length; start += BATCH) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
    body: withCursor.slice(start, start + BATCH).join("\n"),
  });
  if (!response.ok) {
    console.error(`Import failed at line ${start + 1}: HTTP ${response.status}`);
    process.exit(1);
  }
  const result = (await response.json()) as { imported: number; skipped: number; invalidLines: number[] };
  imported += result.imported;
  skipped += result.skipped;
  for (const line of result.invalidLines) console.error(`Invalid line ${start + line}`);
}
console.log(`Imported ${imported} mappings; skipped ${skipped} (unknown account or thread already mapped).`);
