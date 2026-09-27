# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security
advisories) on this repository. Do not open a public issue. Include the affected version or commit,
steps to reproduce, and the impact you expect. We aim to acknowledge reports within a few working
days.

## Supported versions

Only the latest commit on `main` is supported.

## Scope and design notes

This service holds credentials that can act in Chatwoot and Discord, so please pay particular
attention to:

- Request authentication: Chatwoot webhook HMAC signatures (`src/chatwoot/webhook.ts`), Discord
  interaction Ed25519 signatures, and the optional admin import endpoint (`src/index.ts`).
- Authorization of commands: the Discord user must be linked in config and have their own
  Chatwoot token; the ticket comes from the stored post mapping (`src/commands/handler.ts`).
- Outbound requests: attachment downloads are restricted to Discord's CDN
  (`src/commands/attachments.ts`); Discord messages disable mentions.

Secrets must only be provided as Worker secrets (or `.dev.vars` locally), never in `wrangler.jsonc`
or the repository. Logs must not contain message bodies, tokens, or secrets.
