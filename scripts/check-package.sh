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
  if [ "$package" = chatwoot-discord-relay ]; then
    cp "packages/$package/docs/operator.ts" "$consumer/operator-template.ts"
    cp "packages/$package/docs/legacy-source-bridge.ts" "$consumer/legacy-source-bridge.ts"
  fi
  npm pack -w "$package" --pack-destination "$consumer"
  (
    cd "$consumer"
    npm install --workspaces=false --ignore-scripts --no-save --no-audit --no-fund ./*.tgz typescript @cloudflare/workers-types @types/node@24
    ./node_modules/.bin/tsc -p tsconfig.json
    ./node_modules/.bin/tsc -p tsconfig.worker.json
    if [ "$package" = chatwoot-discord-relay ]; then
      ./node_modules/.bin/tsc -p tsconfig.source-bridge.json
      node operator.mjs
      "$root/node_modules/.bin/cf" build
      node lifecycle.mjs
      "$root/node_modules/.bin/cf" deploy --prebuilt --dry-run
      "$root/node_modules/.bin/cf" build --mode retire-hub
      node lifecycle.mjs retire-hub
      "$root/node_modules/.bin/cf" deploy --prebuilt --dry-run --mode retire-hub
      mkdir operator
      cp package.json operator/package.json
      cp operator-template.ts operator/operator.ts
      cp "$root/packages/$package/docs/operator.config.ts" operator/cloudflare.config.ts
      cp vite.config.ts operator/vite.config.ts
      (cd operator; "$root/node_modules/.bin/cf" build; "$root/node_modules/.bin/cf" deploy --prebuilt --dry-run)
      mkdir source-bridge
      cp package.json source-bridge/package.json
      cp legacy-source-bridge.ts source-bridge/index.ts
      cp vite.config.ts source-bridge/vite.config.ts
      cp "$root/packages/$package/test/package/source-bridge.config.ts" source-bridge/cloudflare.config.ts
      (cd source-bridge; "$root/node_modules/.bin/cf" build; node ../lifecycle.mjs source-bridge; "$root/node_modules/.bin/cf" deploy --prebuilt --dry-run)
    fi
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
