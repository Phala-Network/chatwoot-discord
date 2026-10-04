import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = JSON.parse(readFileSync(".cloudflare/output/v0/workers/default/worker.config.json", "utf8"));
if (process.argv[2] === "source-bridge") {
  assert.deepEqual(Object.keys(worker.exports), ["Hub"]);
  assert.equal(worker.exports.Hub.storage, "sqlite");
  assert.equal(worker.exports.Hub.state, undefined);
  process.exit(0);
}
const classes = [
  "Conversation",
  "ThreadDirectory",
  "TriageBudget",
  "AccountSweep",
  "QueueDigest",
  "ForumRegistry",
  "DiscordRateLimit",
];
assert.deepEqual(Object.keys(worker.exports).sort(), [...classes, "Hub"].sort());
for (const name of classes) assert.equal(worker.exports[name].storage, "sqlite", name);
if (process.argv[2] === "retire-hub") assert.equal(worker.exports.Hub.state, "deleted");
else assert.equal(worker.exports.Hub.storage, "sqlite");
