#!/usr/bin/env node
// Stores a configuration in the CONFIG_STORE KV namespace (see stored-config.ts) with the Cloudflare
// CLI (cf, from the calling project), and prints its key. In this repository:
//
//   npm run -s store-config -- config.jsonc --namespace-id <CONFIG_STORE namespace id>
//
// From a project that depends on the package: npx chatwoot-discord-store-config <same arguments>

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { storedConfig } from "./stored-config.ts";

const { values, positionals } = parseArgs({ options: { "namespace-id": { type: "string" } }, allowPositionals: true });
const [file] = positionals;
const namespaceId = values["namespace-id"];
if (!file || !namespaceId) {
  console.error("Usage: chatwoot-discord-store-config <config.jsonc> --namespace-id <id>");
  process.exit(2);
}

try {
  const { key, value } = storedConfig(file);
  // cf reports on stderr, so stdout holds the key alone.
  execFileSync("npx", ["cf", "kv", "keys", "put", key, "--namespace-id", namespaceId, "--body", value], {
    stdio: ["ignore", process.stderr, process.stderr],
  });
  console.log(key);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
