import { readFileSync } from "node:fs";

const tag = process.env.TAG;
const packages = ["chatwoot-discord-relay", "chatwoot-router"];
const name = packages.find((candidate) => tag?.startsWith(`${candidate}@`));
if (!name) throw new Error("The release tag must name a published workspace");
const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
if (manifest.name !== name || tag !== `${name}@${manifest.version}` || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("The release tag must match the workspace's stable version");
}
console.log(`workspace=${name}`);
