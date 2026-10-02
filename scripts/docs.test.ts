import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { bindings, exports } from "cf/config";

test("package documentation uses exported cf binding and Worker export APIs", async () => {
  for (const name of ["chatwoot-discord-relay", "chatwoot-router"]) {
    const root = join("packages", name);
    const files = await readdir(root, { recursive: true });
    for (const file of files.filter(
      (path) => path === "README.md" || (path.startsWith("docs/") && path.endsWith(".md")),
    )) {
      const source = await readFile(join(root, file), "utf8");
      for (const match of source.matchAll(/\b(bindings|exports)\.(\w+)\(/g)) {
        assert.ok(
          Object.hasOwn(match[1] === "bindings" ? bindings : exports, match[2] ?? ""),
          `${root}/${file}: ${match[0]}`,
        );
      }
    }
  }
});
