# Contributing

Thanks for helping! Bug reports and pull requests are welcome. Everyone taking part is expected
to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described
in [SECURITY.md](SECURITY.md), not in a public issue.

## Development

Requirements: Node 24 and pnpm (the version is pinned in `package.json`; `corepack` or
`pnpm/action-setup` will pick it up).

```sh
pnpm install --frozen-lockfile
pnpm lint        # Biome (formatting + lint); `pnpm format` applies fixes
pnpm typecheck   # TypeScript strict, Worker and Node (scripts) projects
pnpm test        # Vitest inside workerd via @cloudflare/vitest-pool-workers
pnpm build       # wrangler dry-run bundle (no deploy)
```

## Guidelines

- Keep the Worker request path fast (the Free plan allows 10 ms CPU); do slow work in the Hub
  Durable Object and keep each alarm run under the subrequest budget.
- Treat Chatwoot's REST API as the source of truth; webhooks only trigger work.
- Use the generated Chatwoot types (`pnpm gen:chatwoot`) and `discord-api-types`. If Chatwoot's
  published spec lacks a route, verify it in Chatwoot's source for the pinned version and add a
  small documented wrapper in `src/chatwoot/api.ts`.
- No `any`, `as unknown as`, non-null assertions, or `@ts-ignore`.
- Tests describe behaviour and mock HTTP at the `fetch` boundary; they must never reach the
  network. Use placeholder ids and `example.com` domains.
- Never log message bodies, tokens, or secrets.
- Keep user-visible text in English and consistent with the existing formats.

## Pull requests

Describe the change and how you verified it. CI must pass (lint, typecheck, tests, dry-run build).
Add user-visible changes to the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md), following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Releases

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public interface
is what an operator depends on: the `CONFIG` keys, the Worker secrets, the HTTP endpoints, the
Discord commands, and the required Chatwoot and Discord setup. A change that makes an existing
deployment need operator action is a major version (a minor version while the major is `0`).

To release, a maintainer:

1. Opens a pull request that moves the "Unreleased" entries in `CHANGELOG.md` under a new
   `## [x.y.z] - YYYY-MM-DD` heading, updates the comparison links at the bottom, and sets
   `version` in `package.json` to `x.y.z`.
2. Merges it once CI passes.
3. Tags the merge commit and publishes a GitHub release with that changelog section as notes:
   ```sh
   git tag -a vx.y.z -m "vx.y.z" && git push origin vx.y.z
   gh release create vx.y.z --title "vx.y.z" --notes "<changelog section>"
   ```

The package is not published to npm (`"private": true`); operators deploy a release with
`wrangler deploy`.
