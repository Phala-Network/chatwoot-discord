import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (!["chatwoot-discord-relay", "chatwoot-router"].includes(manifest.name)) {
  throw new Error("Run build:package from a published workspace");
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status ?? result.signal}`);
}

rmSync("lib", { recursive: true, force: true });
run("cf", ["workers", "types"]);
await build({
  entryPoints: ["src/index.ts", "scripts/stored-config.ts", "scripts/store-config.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outbase: ".",
  outdir: `lib/packages/${manifest.name}`,
});
run("tsc", ["-p", "tsconfig.package.json"]);
run("tsc", ["-p", "tsconfig.package-node.json"]);
mkdirSync("lib/shared/chatwoot", { recursive: true });
copyFileSync("../../shared/chatwoot/schema.d.ts", "lib/shared/chatwoot/schema.d.ts");
