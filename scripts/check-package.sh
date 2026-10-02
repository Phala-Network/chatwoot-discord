#!/usr/bin/env bash
set -euo pipefail

root=$(pwd)
scratch=$(mktemp -d "$root/.package-check.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

for package in chatwoot-discord-relay chatwoot-router; do
  cp "packages/$package/package.json" "$scratch/$package.json"
done
for package in chatwoot-discord-relay chatwoot-router; do
  consumer="$scratch/$package"
  mkdir -p "$consumer"
  cp -R "packages/$package/test/package/." "$consumer/"
  npm pack -w "$package" --pack-destination "$consumer"
  (
    cd "$consumer"
    npm install --workspaces=false --ignore-scripts --no-save --no-audit --no-fund ./*.tgz typescript @cloudflare/workers-types @types/node@24
    ./node_modules/.bin/tsc -p tsconfig.json
    ./node_modules/.bin/tsc -p tsconfig.worker.json
    if [ "$package" = chatwoot-router ]; then
      command=chatwoot-router-store-config
    else
      command=chatwoot-discord-store-config
    fi
    "./node_modules/.bin/$command" && exit 1 || test "$?" -eq 2
  )
done

npm pkg fix --workspaces
for package in chatwoot-discord-relay chatwoot-router; do
  cmp "$scratch/$package.json" "packages/$package/package.json"
done
