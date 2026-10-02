// A configuration too large for the CONFIG var (a var holds 5 KB), as stored in the CONFIG_STORE KV
// namespace: validated, and under a key derived from its content, so a version keeps the
// configuration it was deployed with (also when rolled back to), and storing an unchanged
// configuration again changes nothing. Used by store-config.ts, and by a deployment's
// cloudflare.config.ts for the CONFIG_KEY it deploys with:
//
//   CONFIG_KEY: bindings.text(storedConfig("config.jsonc").key),

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import type { z } from "zod";

/** The configuration in `file` (JSON with comments), validated; throws when it is invalid. */
export function readStoredConfig(file: string | URL, configSchema: z.ZodType): { key: string; value: string } {
  const errors: ParseError[] = [];
  const config: unknown = parse(readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `${file} is not JSON: ${errors.map((e) => `${printParseErrorCode(e.error)} at ${e.offset}`).join("; ")}`,
    );
  }
  const result = configSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid CONFIG: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const value = JSON.stringify(config);
  return { key: `config-${createHash("sha256").update(value).digest("hex")}`, value };
}
