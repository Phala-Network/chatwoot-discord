# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Upgrading: re-register the commands after deploying (`npm run register-commands`), for the new
`/reply` and `/note` options and the new `/unassign` and `/label` commands. `CONFIG` is now validated strictly: remove any key the
[configuration reference](README.md#configuration-reference) does not list (the old
`discord.applicationId` is still accepted). On deploy, the database migrates once: posts gain
two title columns (empty for existing posts, which keep their titles), and the unused
`deliveries` table is dropped, so versions before 0.2.0 can no longer run on it. Each existing
post's stored state no longer matches its new format, so the next sync of each conversation
(its next event, or the sweep for recent ones) updates its tags once. Queued jobs keep working.
`relay.subrequestBudget` must now be at least `relay.maxChunks` + 24 (the default 45 fits
`maxChunks` up to 10).

### Added

- The README explains what the service is for, how it works, and its design, with illustrations
  of the forum and a ticket post (fictional data).
- `docs/ai-agent.md` describes how to connect an AI agent (triage bot).
- A Deploy to Cloudflare button in the README, with the steps after deploying.
- `/reply` and `/note` take optional `message` and `attachment` options that send at once,
  without the editor; without options they open the editor as before.
- A reply the channel could not deliver (Chatwoot marks it failed, e.g. outside WhatsApp's
  24-hour window) gets one ⚠️ notice in its post; `/reply` refuses to send when the conversation's
  channel does not accept a reply (`can_reply`).
- Priority and Chatwoot labels become forum tags when a tag of that name exists (after account,
  status, assignee, and topic; Discord applies at most 5).
- The post title follows the contact's name (for posts created from this version on).
- Chatwoot @mentions in messages show as `@name`; a linked agent mentioned in a private note is
  pinged.
- Shared contacts and locations are shown instead of being dropped.
- `accounts[].inboxIds` limits an account to some of its inboxes.
- An agent's replies and notes show the agent's own avatar instead of the Chatwoot icon: the
  Discord avatar of the linked Discord user (`agents[]`, looked up at most once a day per agent),
  else the agent's Chatwoot avatar. Agent bots, activity lines, cards, and notices keep
  `avatars.chatwoot`.
- A command dropped because it could not start in time tells the invoker.
- `/unassign` removes the assignee, and `/label add|remove <label>` changes one label.
- The ticket card names every Chatwoot channel type and shows the contact's phone number on SMS,
  Twilio, and WhatsApp.
- Instagram story mentions and reels, `fallback` attachments, LINE stickers, Telegram shared
  contacts' names, and bots' options, cards, and articles are shown instead of dropped.
- README: installing on an existing Chatwoot (`relay.startAfterMessageId`), forum tag limits and
  the "Require tags" setting.

### Changed

- The triage mention and pings go on the last Discord message of a split message, so a bot sees
  the whole message when it is called.
- Messages created more than `reconcile.lookbackSeconds` ago (the history relayed when an older
  conversation gets its post, or a catch-up after downtime) are posted without notifications and
  do not use the triage budget.
- Conversation events (`conversation_updated`, `conversation_status_changed`) sync after 10
  seconds, so the activity message for the change is posted with it.
- A job that fails 10 times is dropped instead of retrying forever; the sweep and the next event
  pick its conversation up again. A rate limited job waits as long as Discord asks, without
  counting an attempt.
- Only a request Discord refuses as invalid (a 4xx other than 401, 403, 404, 408, 429) counts
  towards skipping a message after `relay.maxAttempts`; rate limits, server errors, timeouts, and
  missing permissions retry until they succeed.
- Every outbound request times out after 60 seconds.
- An email is relayed without the earlier emails it quotes, as Chatwoot forwards it; an
  automatic reply notifies nobody.
- A newly assigned agent is pinged in a notice of its own after the assignment's activity line,
  so two quick reassignments ping the latest assignee after the latest line.
- Customer text cannot call the triage bot or look like a relay notification: mention tokens,
  `@everyone`, `@here`, and a leading `-#` get a zero-width space.
- Drafts are read with CommonMark's code fence rules (three or more backticks or tildes, closed
  by a matching fence), so a draft may contain a code block.
- A linked agent whose Chatwoot user left the account is told so instead of "not linked".
- A forum tag deleted in Discord since it was cached no longer fails posts: the request is sent
  once more with the tags read again.
- A sweep that stops at its page limit continues from the oldest activity it read next time.
- The link attribute is written whenever it does not point to the conversation's post, so a link
  that could not be written is retried on a later sync.
- A command that finds its conversation deleted closes its post.
- `CONFIG` rejects unknown keys, a `relay.subrequestBudget` too small for `relay.maxChunks`, and
  a `triage.name` over 100 characters. The budget must fit a run's setup and one message's worst
  case, at least `relay.maxChunks` + 24 (`src/relay/limits.ts`); budgets that were accepted before
  but could never relay a message are now rejected.
- `wrangler.jsonc` is committed with placeholder `CONFIG` (it replaces `wrangler.example.jsonc`);
  edit it in place, and `npm run deploy` deploys it. `package.json` describes each secret for the
  Cloudflare dashboard.
- Runtime types are generated with `wrangler types` (`worker-configuration.d.ts`) instead of the
  `@cloudflare/workers-types` package, and the compatibility date is 2026-08-15.
- wrangler 4.142.0.
- npm replaces Bun as the package manager and script runner (`npm ci`, `npm run <script>`,
  lockfile `package-lock.json`, npm 12 pinned in `packageManager`): Workers Builds and Dependabot
  cannot read Bun 1.4's lockfile. `allowScripts` lets only esbuild and workerd run install scripts.
  `register-commands` runs with Node's type stripping and takes its options after `--`
  (`npm run register-commands -- --application <app id> --guild <guild id>`).
- TypeScript 7. `gen:chatwoot` runs openapi-typescript 7.13.0 with TypeScript 5.9.3 through `npx`,
  since openapi-typescript does not support TypeScript 7; it is no longer a dev dependency.

### Removed

- The `deleted-message` job type, queued only by unreleased builds between 0.1.0 and 0.2.0; such
  a job, if one were still queued, is dropped with a warning like any unknown job.
- The unused `deliveries` table.

## [0.2.0] - 2026-09-27

### Added

- Avatars: customers show their Chatwoot avatar or a generic person image (`avatars.contact`,
  Gravatar's "mystery person" by default); everything Chatwoot posts shows the Chatwoot icon
  (`avatars.chatwoot`, the instance's `/favicon-512x512.png` by default).
- `/pending` marks the conversation pending, `/snooze [until]` snoozes it until the next reply or
  for an hour (the dashboard's options that do not depend on the agent's time zone), and
  `/priority <level>` sets or clears its priority, and `/unblock` unblocks the contact.
  Re-register the commands after deploying.
- Customer messages ping the conversation's linked assignee (on the same line as the triage
  mention); agent replies, notes, activity lines, and unassigned conversations ping nobody.
- A message deleted in Chatwoot is deleted from its post once Chatwoot's API confirms it.
- A customer's response to an interactive message (option pick, form, CSAT rating, or email
  request) is posted into the conversation's post under the customer's name, formatted like
  Chatwoot's Slack integration, once Chatwoot's API confirms it (from `message_updated`). A
  response is posted once; a changed response is posted again.
- A conversation that no longer exists in Chatwoot gets a notice in its post, which is archived
  and forgotten.

### Changed

- Bun replaces pnpm as the package manager and script runner (`bun install`, `bun run <script>`,
  lockfile `bun.lock`); `register-commands` runs with Bun instead of tsx. Vitest and wrangler still
  run on Node 24.
- The status tag is the conversation's Chatwoot status (`open`, `pending`, `snoozed`, or
  `resolved`); only resolved posts are archived.
- Every Chatwoot call uses a route listed in the published OpenAPI spec: `/block` resolves the
  conversation and blocks its contact, and the sweep pages through the conversation list, most
  recent activity first, instead of using `updated_within`. Responses use the generated types,
  except messages.
- Discord calls are typed with `discord-api-types` and follow per-bucket and global rate limits.
- `/assign` confirms with the agent's Chatwoot `name`, which is also the assignee tag.
- The `conversation_created` webhook event is ignored; it is no longer needed.

### Fixed

- A post deleted in Discord no longer makes a tags-only update retry forever; the mapping is
  forgotten and the next message starts a new post.
- Tags of an archived post (resolved, or archived by Discord for inactivity) are updated:
  the post is unarchived with the new tags, then archived again if resolved.
- A retry no longer posts a message twice: each Discord message is recorded when it is sent, the
  cursor advances as soon as a message is fully posted, and tags are updated once per run.
- The first message in a post adopted from another relay no longer pings the assignee again:
  without a recorded state, an unchanged assignee cannot be told apart from a new one.
- Queued jobs and cached forum data are validated when read; unreadable jobs are dropped.

### Removed

- `discord.applicationId` from `CONFIG` (unused; an existing value is ignored).
- Webhook delivery deduplication by `X-Chatwoot-Delivery`: Chatwoot sends account webhooks
  once, and relaying is idempotent.

## [0.1.0] - 2026-09-27

### Added

- Relay from Chatwoot to a Discord forum: one post per conversation with a ticket card, every
  message as a reply under its sender's name and avatar, private notes and activity lines, and
  splitting of long messages with a truncation note.
- Forum tags for the account, `open`/`resolved`, the assignee, and a topic attribute; resolved
  posts are archived and reopened ones unarchived.
- A one-time ping for a newly assigned, linked agent, and an optional triage bot mention with
  per-conversation and hourly budgets.
- The post URL is stored in the conversation's `discord_thread` custom attribute, and existing
  posts are adopted from that attribute during a cutover.
- Discord commands that act in Chatwoot as the invoking agent: `/reply` (with attachments),
  `/note`, `/resolve`, `/reopen`, `/assign`, `/block`, and the "Reply with this" message command.
  A command that cannot start within 12 minutes is dropped, because Discord's interaction token
  (valid 15 minutes) could no longer report its result.
- A single SQLite-backed Durable Object with a job queue, alarms, retries with backoff, a
  per-invocation subrequest budget, and a cron reconciliation sweep for missed webhooks.
- Verification of Chatwoot webhook HMAC signatures and Discord Ed25519 interaction signatures.

[Unreleased]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Phala-Network/chatwoot-discord/releases/tag/v0.1.0
