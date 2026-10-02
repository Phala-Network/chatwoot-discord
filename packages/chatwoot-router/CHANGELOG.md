# Changelog

## [Unreleased]

### Added

- Independent Chatwoot routing Worker extracted from chatwoot-discord-relay: TypeSafe Jev decisions, owner/topic/kind
  classification, request detection, redaction, reply-once canned responses, and durable retries.
- Signed per-account webhooks and a five-minute reconciliation sweep, with per-account conversation display-id
  cutover watermarks (`startAfterConversationId`, an account-id map; omitted accounts default to `0`).
- Conversation custom attributes coordinate routing completion and handled messages with chatwoot-discord-relay.
- Standalone npm package, Worker exports, and `chatwoot-router-store-config` for immutable KV configuration.

### Changed

- Use a level-triggered reconciler: webhooks and sweeps enqueue the same conversation key, and each run
  derives desired actions and coordination attributes from current Chatwoot observations. Document the model
  in the README's "How it works" section.
- Memoize Jev answers by the ids of the first three customer messages with usable redacted text. Before
  effects, re-read that input key; a different key defers the existing job without applying the old plan.
  Remove decision states, event evidence watermarks, moving text windows, and state-specific deferrals.
- Run one-time automation per input version, not continuous ownership of assignment or labels. Record every
  action in one effects ledger: assignment and labels after confirmed success or an already-satisfied read;
  reply and status before the request. Recorded effects never run again for the same input key, so Manage
  unassignment and cleared labels remain final. The reply key stays per conversation. Failed or uncertain
  irreversible attempts are not repeated; only confirmed kind actions contribute to `routing_handled`.
- Project a durable, monotonic `routing_seen` checkpoint and ledger-derived handled/kind attributes. Attribute
  synchronization repairs every status without repair jobs, even after messages leave the bounded read window
  or labels are cleared. Compare numeric or numeric-string watermarks without lowering existing values;
  only write changed attributes, retaining unrelated keys.
- Use indexed cache key ranges for ledger reads and exact keys for memo lookups, without whole-cache scans.
  Remove the unused webhook message id; events identify conversations, not decision inputs.
- Reserve the actual worst-case 15 subrequests before starting a route, including the version check and
  attribute synchronization.

### Fixed

- Retry transient reads, classification, assignment, labels, canned-response lookup, and attribute writes;
  memoized inputs and observed side effects avoid duplicate classification and assignment after lost responses.
  A missing canned response keeps the job queued without recording an attempt.
- Re-read eligibility before actions so a person closing, reassigning, or blocking during Jev prevents action.
  Continue a retry assigned to the decision's own owner. A later reopening reconciles the same memoized inputs.
- Skip blocked and pre-cutover tickets while acknowledging customer messages. Attachment-only and
  identifier-only messages do not consume the text window. Redact identifiers before contact names.
- Filter internal messages using Chatwoot v4.18's `filter_internal_messages` parameter, without changing
  relay reads. Keep the bounded scan for public replies: an incomplete window permits no status action.
- Sweep all statuses newest activity first without a barrier, so closing conversations cannot shift tickets
  out of the list. Share resumable page/window logic with the relay, anchored to the previous pass's start.
  Duplicate listings are harmless, and a failing account's sweep does not block other jobs.
- Keep fixed coordination names and require webhook secrets for every routed account. Drop and log JSON
  conversation-not-found responses, including message reads and writes; back off for other errors.
- Use `bindings.kv` in configuration examples; check documented CLI API names against installed sources.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/commits/main/packages/chatwoot-router
