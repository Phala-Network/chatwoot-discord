# Changelog

## [Unreleased]

### Added

- Independent Chatwoot routing Worker extracted from chatwoot-discord-relay: TypeSafe Jev decisions, owner/topic/kind
  classification, request detection, redaction, reply-once canned responses, and durable retries.
- Signed per-account webhooks and a five-minute reconciliation sweep, with per-account conversation display-id
  cutover watermarks (`startAfterConversationId`, an account-id map; omitted accounts default to `0`).
- Conversation custom attributes coordinate routing completion and handled messages with chatwoot-discord-relay.
- Standalone npm package, Worker exports, and `chatwoot-router-store-config` for immutable KV configuration.

### Fixed

- `routing_seen` acknowledges every processed customer message, including assigned, closed, pre-cutover,
  already-routed, and no-owner tickets, only after all applicable actions. Handled and kind attributes accompany
  the completion watermark; assignment/status changes alone cannot release the relay's wait.
- Sweep paging blocks route jobs, including while a failed page backs off, so closing tickets cannot shift the
  next page and skip half a pass. Open assigned and pre-cutover tickets also receive completion checks.
- Durable completion attributes repair lost Chatwoot read-merge-save updates on webhooks and sweeps without
  lowering watermarks or replaying classification/replies. Identical attributes do not trigger another write.
- The KV configuration example uses the Cloudflare CLI's `bindings.kv` API; documentation API names are checked
  against the installed CLI during tests.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/commits/main/packages/chatwoot-router
