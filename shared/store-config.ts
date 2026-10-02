import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export function storeConfig(storedConfig: (file: string) => { key: string; value: string }, command: string): void {
  const { values, positionals } = parseArgs({
    options: { "namespace-id": { type: "string" } },
    allowPositionals: true,
  });
  const [file] = positionals;
  const namespaceId = values["namespace-id"];
  if (!file || !namespaceId) {
    console.error(`Usage: ${command} <config.jsonc> --namespace-id <id>`);
    process.exit(2);
  }

  let stored: { key: string; value: string };
  try {
    stored = storedConfig(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // The value goes in a file, not on the command line: it stays out of process listings and errors.
  const dir = mkdtempSync(join(tmpdir(), "store-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, stored.value);
    // cf reports on stderr, so stdout holds the key alone.
    const put = spawnSync(
      "npx",
      ["cf", "kv", "keys", "put", stored.key, "--namespace-id", namespaceId, "--file", path],
      {
        stdio: ["ignore", process.stderr, process.stderr],
      },
    );
    if (put.status === 0) {
      console.log(stored.key);
    } else {
      console.error(`Storing ${stored.key} failed: cf exited with ${put.status ?? put.signal}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
