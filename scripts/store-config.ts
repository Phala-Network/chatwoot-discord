// Stores a configuration too large for the CONFIG var (a var holds 5 KB) in the CONFIG_STORE KV
// namespace, and prints the key the Worker reads it from:
//
//   key=$(npm run -s store-config -- config.jsonc) && npx wrangler deploy --var "CONFIG_KEY:$key"
//
// The file holds what CONFIG would, as JSON with comments; it is validated before it is stored. The
// key is derived from the configuration, so a version keeps the configuration it was deployed with
// (also when rolled back to), and storing an unchanged configuration again changes nothing.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { configSchema } from "../src/config.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run -s store-config -- <config.jsonc>");
  process.exit(2);
}

const errors: ParseError[] = [];
const config: unknown = parse(readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
if (errors.length > 0) {
  console.error(
    `${file} is not JSON: ${errors.map((e) => `${printParseErrorCode(e.error)} at ${e.offset}`).join("; ")}`,
  );
  process.exit(1);
}
const result = configSchema.safeParse(config);
if (!result.success) {
  console.error(`Invalid CONFIG: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  process.exit(1);
}

const value = JSON.stringify(config);
const key = `config-${createHash("sha256").update(value).digest("hex")}`;
// Wrangler reports on stderr, so stdout holds the key alone.
execFileSync("npx", ["wrangler", "kv", "key", "put", key, value, "--binding", "CONFIG_STORE", "--remote"], {
  stdio: ["ignore", process.stderr, process.stderr],
});
console.log(key);
