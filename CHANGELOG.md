# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/pending` marks the conversation pending, `/snooze [until]` snoozes it until the next reply or
  for an hour (the dashboard's options that do not depend on the agent's time zone), and
  `/priority <level>` sets or clears its priority. Re-register the commands after deploying.
- Customer messages ping the conversation's linked assignee (on the same line as the triage
  mention); agent replies, notes, activity lines, and unassigned conversations ping nobody.
- A message deleted in Chatwoot is deleted from its post once Chatwoot's API confirms it.
- A conversation that no longer exists in Chatwoot gets a notice in its post, which is archived
  and forgotten.

### Changed

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

[Unreleased]: https://github.com/Phala-Network/chatwoot-discord/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Phala-Network/chatwoot-discord/releases/tag/v0.1.0
