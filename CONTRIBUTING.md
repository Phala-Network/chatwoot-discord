# Contributing

Thanks for helping! Bug reports and pull requests are welcome.

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
