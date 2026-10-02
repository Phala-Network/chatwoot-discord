# Contributing

Thanks for helping! Follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues privately as
explained in [SECURITY.md](SECURITY.md). Keep changes scoped, with behavior tests and a package changelog entry.

## Workspace development

This private npm workspace root contains two independently published packages:

- `packages/chatwoot-discord-relay`: the Discord relay and Hub Durable Object.
- `packages/chatwoot-router`: TypeSafe Jev routing and the Router Durable Object.
- `shared`: Chatwoot API/schema types, webhook authentication, the SQLite queue/cache, subrequest budget,
  immutable config/KV loading, and logging. It is source code, not an npm package.

There is one root `package-lock.json`. Use Node 24 (24.15 or newer) and npm 12.1.0 as pinned in `packageManager`.
Run npm, tests, and builds inside Docker, not on the host:

```sh
docker run --rm --cpus=2 --memory=4g -v "$PWD:/workspace" -w /workspace \
  -e CF_SEND_TELEMETRY=false node:24 bash -lc '
    npm install -g npm@12.1.0
    npm ci
    npm run lint
    npm run typecheck
    npm test
    npm run build
    for package in chatwoot-discord-relay chatwoot-router; do
      (cd "packages/$package" && npx cf deploy --prebuilt --dry-run)
    done
    npm run check:package
  '
```

Use `npm test -w chatwoot-router` or `npm run typecheck -w chatwoot-discord-relay` for focused checks inside
that container. `npm run format` applies the shared Biome configuration. `allowScripts` at the root allows
only esbuild and workerd install scripts; review additions. Do not introduce another package lock.

Each package has its own `cloudflare.config.ts`, Vite config, Vitest Workers-pool config, README, changelog,
secret examples, and consumer fixture. Keep compatibility dates consistent between deployment and tests.
Each package declares the same pinned `@cloudflare/vite-plugin`. The pinned `cf` beta detects its implementation
only in the local manifest and local `node_modules`, not hoisted dependencies. The root `.npmrc` therefore uses
npm's supported `install-strategy=linked`; npm manages the local links without dependency patches. Shared source
dependencies are also declared as root dev dependencies so source imports resolve without accidental hoisting.
`cf workers types` generates local `.cloudflare/types`; runtime bindings are declared in each `src/env.ts`.
Tests mock HTTP at the fetch boundary and must not reach live services. All example and screenshot data must
be fictional. Relay illustrations stay in `packages/chatwoot-discord-relay/docs/assets`; render them with its
Docker-based `render.sh` only when changing the illustrations.

Scripts run with Node's type stripping and `.ts` imports, using erasable syntax. Shared TypeScript options
live in `tsconfig.base.json`. A package build bundles shared source into its JavaScript with esbuild; emitted
`.d.ts` files and the generated Chatwoot schema are contained under that tarball's `lib` directory.
The consumer check installs each tarball separately, type-checks Worker and Node imports without `skipLibCheck`,
and executes its configuration bin's usage path. Do not introduce public type references to unpublished
workspaces or paths outside the tarball.

## Engineering guidelines

- Keep webhooks fast: authenticate, durably enqueue, and acknowledge. Alarms own slow work and retry it.
- Preserve the relay's SQLite migration history and Worker identity during upgrades.
- Treat Chatwoot as the only coordination surface between packages. Do not add service bindings or shared state.
- Bound every alarm's outbound requests; adjust the budget when adding a request to the worst-case path.
- Use generated Chatwoot schema types (`npm run gen:chatwoot -w chatwoot-router`), and verify contracts against
  official documentation or source before changing them. Keep the pinned API version in sync.
- No `as any`, `as unknown as`, non-null assertions, or `@ts-ignore`; no message bodies or credentials in logs.
- Keep code and user-visible text in English. Add behavior tests rather than implementation mirrors.

## Releases

Versions are independent. The relay continues its existing version line; the router starts at `0.1.0`.
A maintainer changes only the intended package's version and changelog, updates the root lockfile, and has the
pull request reviewed. Configuration breaks are minor releases while major version is zero. Required checks
remain `check`, `Analyze (actions)`, and `Analyze (javascript-typescript)`.

After the authorized PR merge, publish a non-prerelease GitHub release whose tag is exactly the package name
and its committed version, for example `chatwoot-discord-relay@0.29.0` or `chatwoot-router@0.1.0`.
`.github/workflows/release.yml` validates the name and version, tests that workspace, and runs
`npm publish -w <package>` (which builds through `prepack`). An unknown package, mismatched version, old `vX.Y.Z`
tag, or prerelease cannot publish through this workflow. Never publish the private root.

Both packages use npm trusted publishing, configured separately for `Phala-Network/chatwoot-workers` and
workflow filename `release.yml`, on GitHub-hosted runners with `id-token: write`. No stored npm token is used.
After renaming the repository, update the relay package's existing npm trust. The new unscoped public router
package first needs a maintainer-authorized manual publish of `0.1.0`, then its trusted publisher configured;
that same version cannot be published again. See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Publishing does not deploy either Worker. Infrastructure owners separately provision secrets and custom
attributes, configure Chatwoot webhooks, and deploy from their private configuration. Follow the relay changelog's
cutover order: relay without embedded routing first, then router above the newest conversation id, never both
routers at once. Keep an existing relay Worker's name so its Hub state survives.
