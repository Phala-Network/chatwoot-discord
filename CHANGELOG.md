# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The first message in a post adopted from a previous relay no longer pings the assignee again:
  without a recorded state, an unchanged assignee cannot be told apart from a new one.

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
