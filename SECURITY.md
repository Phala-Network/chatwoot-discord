# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately):
open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public
issue. Include the affected version or commit, steps to reproduce, and the impact you expect. We
aim to acknowledge reports within a few working days.

## Supported versions

Only the latest release and the latest commit on `main` receive security fixes.

## Scope and design notes

This service holds credentials that can act in Chatwoot and Discord, so please pay particular
attention to:

- Request authentication: Chatwoot webhook HMAC signatures (`src/chatwoot/webhook.ts`) and Discord
  interaction Ed25519 signatures (`src/index.ts`).
- Authorization of commands: the Discord user must be linked in config and have their own
  Chatwoot token, whose user must still belong to the account; the ticket comes from the stored
  post mapping (`src/commands/handler.ts`, `src/commands/actions.ts`).
- Outbound requests: attachment downloads are restricted to Discord's CDN
  (`src/commands/attachments.ts`).
- Mentions: relayed messages set `allowed_mentions` so only linked agents can be pinged (the
  assignee, and agents mentioned in a private note), and customer text is defused so it cannot
  mention or pass for relay lines (`src/relay/format.ts`, `src/relay/notify.ts`).

Secrets must only be provided as Worker secrets (or `.dev.vars` locally), never in `wrangler.jsonc`
or the repository. Logs must not contain message bodies, tokens, or secrets.
