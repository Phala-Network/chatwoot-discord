# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-03

### Fixed

- End a kind's turn with resolved/snoozed only after its canned reply is confirmed to exist in Chatwoot. Failed,
  unknown or malformed creation outcomes, incomplete history, and attempts without visible replies hand off to
  people without sending again. A reply seen as failed/deleted in the final fresh read also hands off.
- Recognize historical public outgoing messages from the account's exact brand bot, including the former relay's
  replies, without moving reply ledgers. Preserve the durable attempt/observed guard across turns and upgrades.
- Disconnecting an inbox hands its pending brand-bot leftovers to people with native bot `status=open`. The sweep
  reads pending/open account conversations, including old disconnected inboxes, and retries failed handoffs.
- Release the brand bot immediately after a kind's resolved/snoozed status using its standard unassignment API;
  durable retries finish failed releases. Preserve status, turn boundaries and other owners. The open sweep heals
  Chatwoot webhook-failure fallbacks without scanning resolved/snoozed history.

### Changed

- Partition routing by account and conversation, with a separate paged `Coordinator`. Each conversation owns its
  queue, decisions and reply/turn guards; slow conversations no longer occupy another conversation's executor.
- Bound webhook admission and sweep child RPC waits. Persist scan progress independently of failed child
  deliveries, so retries retain unavailable targets while later pages and healthy conversations continue.
- Reuse message pages only within one fresh phase, combine independent read-only preparation, and scope cached
  decisions to actual redacted input and routing configuration/model. Preserve fresh side-effect checks and the
  existing bounded history reads and 45-request budget; inbox-bot ownership is read fresh instead of cached.

### Upgrade

- This minor release changes deployment bindings. Export and declare SQLite `Router` and `Coordinator`, bound as
  `ROUTER` and `COORDINATOR`, and keep the five-minute reconciliation trigger. Conversation Router identities are
  now `<account>:<conversation>`; account for any existing global Router guards before enabling
  new owners. Keep Worker identities, namespaces/storage and immutable configuration keys.
- Deploy chatwoot-discord-relay 0.31.0 first, completing its separately authorized
  [partition adoption](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-discord-relay/docs/adoption.md)
  when upgrading an existing Hub. Verify the sole routing owner before connecting bots one account at a time;
  health checks and webhook acknowledgements do not establish successful routing or channel delivery.
- To stop routing, disconnect bots but retain credentials and keep this router running until pending/open account
  passes and durable ending retries clear all brand-bot ownership. Verify resolved/snoozed endings too, preserving
  human and other-bot owners. Only then stop ingress, cron, queued alarms and in-flight work.
- Preserve permanent reply attempts, observed/deleted-reply records, unknown guards and turn boundaries. Empty
  history cannot reconstruct lost guards or justify another send. The legacy relay's reply ledger is independent;
  restoring old code/configuration does not transfer Router-only replies or unknown attempts. Once new effects
  exist, use forward repair in the current namespaces; direct version rollback to relay 0.27 is not a safe handover
  and Cloudflare rollback cannot cross Durable Object class/lifecycle changes.

## [0.2.0] - 2026-10-03

### Changed

- The router is each routed inbox's Chatwoot agent bot (the account's brand bot). It works on `pending` conversations:
  it decides on the customer's first three messages of the bot's turn, adds the topic and kind labels, sends the kind's
  canned reply as the bot, and ends the turn with the kind's status, the owner's assignment, or a handoff to people.
  A person who takes, replies to, or reopens the ticket owns it; a resolved conversation the customer reopens comes
  back to the bot and is decided on its new messages (a snoozed one reopens for people). After three failed attempts,
  or when the kind's canned response does not exist, it hands the ticket to people. See "How it works" in the README.
- Replaces the `routing_*` conversation attributes, `startAfterConversationId`, the account webhook, `reconcile` (the
  sweep lists every `pending` conversation), and `routing.snoozeUnclear`: a greeting stays with the bot until the
  customer asks something or has sent three messages with text, then goes to people.

### Added

- `routing.endpoint`: the URL of TypeSafe's System One API (default `https://api.typesafe.ai/v1/systemone`), for
  example a proxy or gateway.

### Upgrade

- Deploy chatwoot-discord-relay 0.30.0 first. Raise `subrequestBudget` to at least 45 (was 20), remove `reconcile`
  and `routing.snoozeUnclear`, add `routing.botIds`, and replace `CHATWOOT_WEBHOOK_SECRETS` and
  `CHATWOOT_BOT_TOKENS` with `CHATWOOT_AGENT_BOT_SECRETS` and `CHATWOOT_AGENT_BOT_TOKENS`. Then set each bot's webhook
  URL to `/chatwoot/agent-bot` and connect it to the routed inboxes, one account at a time; existing `pending`
  conversations become the bot's. Roll back by disconnecting the bots ([Upgrade and rollback](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/README.md#upgrade-and-rollback)).

## [0.1.0] - 2026-10-02

### Added

- First release: the TypeSafe Jev routing of chatwoot-discord-relay 0.28.0 as its own Cloudflare Worker. A new ticket
  gets its owner, its topic label, and its kind (with a canned response and a status, if the kind has them), once per
  version of its first three customer messages; people own the ticket after that. See "How it works" in the README.
- Signed per-account Chatwoot webhooks and a five-minute sweep; per-account `startAfterConversationId` for a cutover.
- Coordination with chatwoot-discord-relay through the conversation attributes `routing_seen`, `routing_handled`, and
  `routing_kind`.
- The `chatwoot-router-store-config` command and `chatwoot-router/stored-config`, for a configuration in KV.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-router@0.3.0...HEAD
[0.3.0]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-router@0.2.0...chatwoot-router@0.3.0
[0.2.0]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-router@0.1.0...chatwoot-router@0.2.0
[0.1.0]: https://github.com/Phala-Network/chatwoot-workers/releases/tag/chatwoot-router@0.1.0
