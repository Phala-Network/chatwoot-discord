# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Run as each routed account's native agent bot. Route pending conversations in its linked inboxes; use status
  activities as turn boundaries, preserve human takeovers, and end with native assignment, resolution/snooze or
  bot handoff. Pending sweeps have no time window and resume pages across alarms; another pass covers page shifts.
- Match a late status webhook to its already-read activity; distinct transitions need a newer boundary id, even
  in the same second. Metadata-only `updated_at` changes never create an activity expectation. Pending observations
  survive retries, preserving the boundary when a resolution succeeds but its response is lost. Merging the first
  timestamped webhook preserves any existing activity ID lower bound, so reopening cannot reuse an older resolution.
- After three processing failures or a missing canned response, persist handoff and retry it until Chatwoot accepts
  it or the turn is no longer eligible. A canned reply's attempt remains once per conversation, even on an unknown
  send outcome. Greeting/no-request tickets stay pending until a request or three usable texts.
- Remove routing attributes, checkpoint/projection, non-reply effects ledger, account-webhook endpoint,
  `startAfterConversationId`, sweep `reconcile` settings and `routing.snoozeUnclear`.

### Upgrade

- Deploy the new relay first; remove its router wait settings and keep all kind names in `router.keepLabels`.
  Stop the old router webhook/cron before replacing it in place. Preserve Worker/DO names and reply records.
- Add `routing.botIds` for exactly the routed accounts. Replace `CHATWOOT_WEBHOOK_SECRETS` and
  `CHATWOOT_BOT_TOKENS` with required `CHATWOOT_AGENT_BOT_SECRETS` and `CHATWOOT_AGENT_BOT_TOKENS` maps.
  The user token must see every routed inbox. Set bot URLs to `/chatwoot/agent-bot`, then connect inboxes account
  by account. Existing pending conversations become eligible; open conversations stay with people.
- The one-time migration clears old queued work/memos/checkpoints/non-reply effects, retaining reply attempts.
  Keep Chatwoot's old attributes until the rollback window ends. Roll back by disconnecting bots first; never run
  old and new routing together. See README "Upgrade and rollback" for the full procedure.

## [0.1.0] - 2026-10-02

### Added

- First release: the TypeSafe Jev routing of chatwoot-discord-relay 0.28.0 as its own Cloudflare Worker. A new ticket
  gets its owner, its topic label, and its kind (with a canned response and a status, if the kind has them), once per
  version of its first three customer messages; people own the ticket after that. See "How it works" in the README.
- Signed per-account Chatwoot webhooks and a five-minute sweep; per-account `startAfterConversationId` for a cutover.
- Coordination with chatwoot-discord-relay through the conversation attributes `routing_seen`, `routing_handled`, and
  `routing_kind`.
- The `chatwoot-router-store-config` command and `chatwoot-router/stored-config`, for a configuration in KV.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-router@0.1.0...HEAD
[0.1.0]: https://github.com/Phala-Network/chatwoot-workers/releases/tag/chatwoot-router@0.1.0
