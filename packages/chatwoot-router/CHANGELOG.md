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

- Recheck customer activity before any kind action, including evidence from the latest messages and the job's
  customer watermark, while the decision has used fewer than three customer inputs. A full window stays valid
  despite later messages, so assigned retries finish their actions. Eligible stale partial-window decisions defer
  their existing queue job instead of losing pending work. New text remains included even beyond the bounded
  scan; only an incomplete read with no confirmed newer message permits finalizing without a status action.
- Filter private messages and activity lines out of router message reads using Chatwoot v4.18's
  `filter_internal_messages` parameter; keep the bounded scan for public agent replies and leave relay reads unfiltered.
- Act only when a fresh read immediately before actions shows an open ticket that is unassigned or assigned to
  exactly the agent the recorded decision assigns. Resume after a lost assignment response or failed label write
  without assigning twice; leave a different assignee alone. Otherwise acknowledge
  `routing_seen` and preserve the decision, including after the router's own snooze or a lost status response.
  Routing resumes from that state after reopening; remove status-intent records and special-case finalization.
- Skip blocked contacts and wait for usable text after attachment-only or redacted-only messages, without Jev
  or automatic actions, while acknowledging them through `routing_seen`. Redact identifiers before contact
  names so a name cannot split an email address into fragments that are sent to Jev.
- Fix coordination names to `routing_seen`, `routing_handled`, and `routing_kind`; remove attribute-name
  configuration. Read numeric-string watermarks without lowering them on a later update.
- Require webhook secrets for every routed account. Log and drop deleted-conversation jobs on Chatwoot's JSON
  404 response, including message reads and writes, while retaining backoff for other errors.
- `routing_seen` acknowledges every processed customer message, including assigned, closed, pre-cutover,
  already-routed, and no-owner tickets, only after all applicable actions. Handled and kind attributes accompany
  the completion watermark; assignment/status changes alone cannot release the relay's wait.
- Sweep all statuses newest activity first, so tickets closed by the router or another actor stay in the paged
  list. Route and repair jobs interleave with pages without a global barrier; a failing account's sweep no longer
  blocks other work. Shared pass-window/cursor logic with the relay resumes failed pages and anchors the next
  window to the previous pass's start, not its finish.
- Durable completion attributes repair lost Chatwoot read-merge-save updates on webhooks and sweeps without
  lowering watermarks or replaying classification/replies. Identical attributes do not trigger another write.
  Persist the applied decision state and completion before the attribute read as well as its write, so a failed
  completion GET is repaired without losing the kind or handled watermark, including after assignment.
  Sweep repairs cover assigned, resolved, and snoozed tickets in the activity window, and only restore recorded
  attributes: they do not scan messages or run routing actions.
- Reserve the actual worst-case 19 subrequests before starting a route, including its final completion write.
- The KV configuration example uses the Cloudflare CLI's `bindings.kv` API; documentation API names are checked
  against the installed CLI during tests.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/commits/main/packages/chatwoot-router
