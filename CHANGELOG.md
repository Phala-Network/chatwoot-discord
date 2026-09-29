# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Routing asks Jev again when the customer adds a message to a ticket without a clear owner, up to
  the first three customer messages, instead of leaving it after the first answer. Decisions
  recorded by 0.5.0 stay final.

## [0.5.0] - 2026-09-29

### Added

- Routing: with the new `routing` setting and the `TYPESAFE_API_KEY` secret, each new ticket of a
  routed account is assigned to its owner and given a topic by TypeSafe Jev when Jev is confident
  enough, once, with identifiers removed from the text it sees. See
  [routing](README.md#routing).

### Fixed

- The example `wrangler.jsonc` no longer has the `tag` keys that 0.4.0 removed, which made its
  `CONFIG` invalid.

## [0.4.0] - 2026-09-28

### Upgrading

- **Breaking:** forum tags are bound by id. Remove `accounts[].tag` and `agents[].tag`, and map
  each forum's tags in `forumTags` by what they stand for, for example
  `{"<forum channel id>": {"account:1": "<tag id>", "status:open": "<tag id>", "assignee:42": "<tag id>"}}`
  (see the [configuration reference](README.md#configuration-reference)). List a forum's tag ids
  with `DISCORD_BOT_TOKEN=... npm run forum-tags -- --forum <forum channel id>`. Tags without an
  entry are no longer applied; renaming a tag in Discord no longer matters. Active posts get their
  tags again on their next sync.

- `relay.subrequestBudget` must be at least `relay.maxChunks` + 26 (was + 24); the default 45
  still fits `maxChunks` up to 10.
- On deploy the database migrates once: it adds a pending-announcement column, interaction
  receipts, the Discord ids of responses and notices, and the message a title quotes.

### Fixed

- A customer message over the triage budget no longer calls the triage bot when its post is
  retried.
- A failed assignee announcement is retried until it is posted, even without new messages.
- A sweep longer than 10 pages continues where it stopped instead of rereading the first 10.
- A failing job is no longer dropped after 10 attempts; it keeps retrying at most every 30
  minutes, so a long outage loses no work.
- A failed write of the post URL to the conversation is retried.
- Deleting a message in Chatwoot also removes the response and notice posted about it, and its
  text from the post's title when the title quotes it.
- A response or delivery failure reported before its message was relayed is posted with the
  message instead of being lost.

### Changed

- The assignee tag is bound to the Chatwoot user id, for linked and unlinked agents alike.

### Security

- Discord interactions signed more than 5 minutes ago are refused, and a command is queued once
  per interaction id, so a replayed request never runs it again.
- A command runs only with a token that belongs to the Chatwoot user the invoker is linked to.
- Chatwoot and Discord API requests no longer follow redirects, which could carry a token to
  another host.
- The forum's webhook is recognized by the application that created it, not by its name.

## [0.3.0] - 2026-09-28

### Upgrading

- **Breaking:** link agents by Chatwoot user id. Replace each `agents[]` entry's `email` with
  `chatwootUserId`: the `id` from `GET /api/v1/profile` with the agent's own token, or from an
  administrator's `GET /api/v1/accounts/<account id>/agents`. `CONFIG` with `email` is invalid.
- `CONFIG` is validated strictly: remove any key the
  [configuration reference](README.md#configuration-reference) does not list, including
  `discord.applicationId`. `relay.subrequestBudget` must be at least `relay.maxChunks` + 24 (the
  default 45 fits `maxChunks` up to 10), and `triage.name` at most 100 characters.
- Re-register the commands after deploying (`npm run register-commands`) for the new `/reply` and
  `/note` options and the new `/unassign` and `/label` commands.
- On deploy the database migrates once: posts gain title columns (existing posts keep their
  titles), the unused `deliveries` table is dropped (versions before 0.2.0 can no longer run on
  it), and each post's announced assignee is cleared (it held a name, now a Chatwoot user id), so
  each post records its current assignee on its next live message without pinging them. Each
  post's tags are updated once on its next sync. An `/assign` queued before the deploy is dropped
  as unreadable (its invoker sees no result); other queued jobs keep working.

### Added

- `/reply` and `/note` take optional `message` and `attachment` options that send at once; without
  options they open the editor.
- `/unassign` removes the assignee; `/label add|remove <label>` changes one label.
- Priority and Chatwoot labels become forum tags when a tag of that name exists.
- `accounts[].inboxIds` limits an account to some of its inboxes.
- `agents[].tag` sets a linked agent's assignee tag, independent of their Chatwoot name.
- An agent's replies and notes show the linked Discord user's avatar (looked up at most once a
  day), else the agent's Chatwoot avatar.
- A newly assigned, linked agent is added to the post.
- A reply the channel could not deliver gets one ⚠️ notice in its post; `/reply` refuses when the
  channel does not accept a reply (`can_reply`).
- The post title follows the contact's name (posts created from this version on).
- Chatwoot @mentions show as `@name`; a linked agent mentioned in a private note is pinged.
- Shared contacts and locations, Instagram story mentions and reels, `fallback` attachments, LINE
  stickers, and bots' options, cards, and articles are shown instead of dropped.
- The ticket card names every Chatwoot channel type and shows the phone number on SMS, Twilio,
  and WhatsApp.
- A command dropped because it could not start in time tells the invoker.
- README: purpose, design, illustrations, a Deploy to Cloudflare button, installing on an
  existing Chatwoot, and forum tag limits; `docs/ai-agent.md` for connecting an AI agent.

### Changed

- Notifications are live-only: messages created more than `reconcile.lookbackSeconds` ago
  (history of an older conversation, a catch-up after downtime) and automatic email replies
  notify nobody and do not use the triage budget.
- The triage mention and pings go on the last line of the last Discord message of a split
  message, so a bot sees the whole message.
- A new assignee is pinged in a notice of its own after the run's messages, and assignees are
  told apart by Chatwoot user id, so a rename does not ping again.
- An email is relayed without the earlier emails it quotes, as Chatwoot forwards it.
- Conversation events sync after 10 seconds, so the change's activity message comes with them.
- Only a request Discord refuses as invalid (a 4xx other than 401, 403, 404, 408, 429) counts
  towards skipping a message after `relay.maxAttempts`; rate limits, server errors, timeouts, and
  missing permissions retry until they succeed. A rate limited job waits as long as Discord asks
  without counting an attempt, and a job that fails 10 times is dropped (the sweep and the next
  event pick its conversation up again). Every outbound request times out after 60 seconds.
- Customer text cannot mention anyone or look like a relay line (mention tokens, `@everyone`,
  `@here`, and a leading `-#` get a zero-width space).
- Drafts are read with CommonMark's code fence rules, so a draft may contain a code block.
- A linked agent whose Chatwoot user left the account is told so instead of "not linked".
- `wrangler.jsonc` is committed with placeholder `CONFIG` (replacing `wrangler.example.jsonc`),
  and `package.json` describes each secret for the Cloudflare dashboard.
- npm replaces Bun (npm 12 pinned in `packageManager`; `allowScripts` limits install scripts to
  esbuild and workerd); `register-commands` runs with Node's type stripping and takes its options
  after `--`.
- TypeScript 7; runtime types come from `wrangler types`; compatibility date 2026-08-15; wrangler
  4.142.0. `gen:chatwoot` runs openapi-typescript through `npx`.

### Fixed

- A forum tag deleted in Discord since it was cached no longer fails posts: the request is sent
  once more with the tags read again.
- A sweep that stops at its page limit continues from the oldest activity it read.
- A link attribute that could not be written is retried on a later sync.
- A command that finds its conversation deleted closes its post.
- Budgets that could never relay a message are rejected at startup.

### Removed

- `agents[].email` (use `chatwootUserId`) and the ignored `discord.applicationId` key.
- The unused `deliveries` table.
- The `deleted-message` job type of unreleased builds; such a job is dropped with a warning.

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

[Unreleased]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Phala-Network/chatwoot-discord/releases/tag/v0.1.0
