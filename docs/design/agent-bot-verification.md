# Native agent bot verification

Verified on October 2, 2026 (PDT) in the `design/agent-bot` worktree. Baseline:
`7f9318cca59f870e8c04a32545992974d6b5f2c2` (relay 0.29.0, router 0.1.0). Versions are unchanged.
The package READMEs' **How it works** sections remain the behavior reference; this document records verification.

## Local commits

| Commit | Change |
| --- | --- |
| `3c447ad` | Preserve the supplied design draft as-is. |
| `ad8fce5` | Complete the seven configuration, lifecycle, recovery and migration contracts. |
| `5348546` | Implement native bot routing and shared Chatwoot/queue support. |
| `ef76416` | Implement relay holding, release, handback and bot assignee handling; update documentation. |
| `c92097f` | Guard asynchronous transition races and inbox response validation; retain failure/account regressions. |

Every commit has the requested coauthor trailer. The report is committed separately. No push, PR, release,
deployment, production API call, or real-secret inspection was performed.

## Implementation size and scope

Physical added/deleted lines relative to the baseline, including comments and blank lines. Package production
counts include `src/`, `scripts/` and `cloudflare.config.ts`; shared counts exclude tests and generated types.
Tests, documentation and examples are excluded. Shared changes are counted once.

| Area | Added | Removed | Net |
| --- | ---: | ---: | ---: |
| chatwoot-router | 389 | 267 | +122 |
| chatwoot-discord-relay | 114 | 93 | +21 |
| shared | 101 | 30 | +71 |
| Total | 604 | 390 | +214 |

Removed the three routing attributes and their definitions/reads/writes, checkpoint/projection, non-reply
effects ledger and its range reader, router account-webhook endpoint, router sweep window,
`startAfterConversationId`, `routing.snoozeUnclear`, and relay `router.accounts`/`waitSeconds`.
Historical changelog entries and upgrade instructions intentionally still name removed settings.

Added scoped inbox bot discovery, per-account bot identity/credentials, pending-only routing and resumable
sweeps, bounded status-activity reads, durable retry/handoff guards, explicit assignee types, native `/pending`
assignment, suspended conversation jobs, and answering-reply eligibility. Existing once-per-conversation reply
attempt records survive migration. No replacement Chatwoot coordination attributes were introduced.

## Verified scenarios

Assertions cover Chatwoot mutations and messages, Jev calls, Discord posts/mentions and durable queue behavior.

| Area | Scenarios |
| --- | --- |
| Scope and credentials | Exact account key maps; positive safe bot ids; missing/invalid credentials; HMAC validation, stale/mismatched signatures, irrelevant-event ACK, old endpoint removed; equal conversation ids in different accounts, separate bot credentials and one account backing off while another completes. |
| Inbox API | Wrapped bot response, null/empty unlinked association, wrong account/system bot, wrong bot id, malformed/unwrapped payload, credential stripping, deleted inbox versus proxy error. |
| Assignee identity | Bot and person sharing a numeric id; bot never gets a human ping, assignee tag or card selection; open plus bot is unassigned; foreign/different bot or person stops routing. |
| Actions and takeover | Labels then canned reply then one ending action; bot token on mutations; assignment ends immediately; resolved/snoozed kinds; empty/unclear handoff; reopened pending without a bot assignee uses handoff; owner removed from the account; human status/assignment/block/disconnect changes during Jev; public human reply during Jev, labels or reply stops planned effects. |
| Inputs and decisions | First three usable texts; greeting stays pending, third greeting hands off; memoized inputs; new messages during Jev/backoff invalidate the old decision; private notes, activity, deleted/automatic/identifier-only input excluded; redaction, IPv4/IPv6, contact identity, email subject and trimmed quoted history, 1,600-character cap; low confidence/invalid Jev choices; manual redirect policy; human/automation topic labels preserved. |
| Turns | Reopened resolved spam uses new messages; handback starts after its activity; new turns discard old failed handoff; newest-first unfiltered `before` paging; asynchronous activity arrival, permanent absence, deleted known activity and bounded-out history; forged customer activity metadata; webhook arriving during the boundary read; human resolution observed by a fresh read before its activity exists. |
| Recovery | Transient conversation/message/Jev/canned/label/assignment/status failures; lost label/assignment/status/reply responses; unknown/failed canned reply never resent; legacy reply records honored; missing canned response immediately chooses durable handoff; Worker 2xx followed by three processing failures and failing handoff still retries; deleted conversation versus proxy 404. |
| Sweep and budget | Pending-only listing without an age cutoff; inbox discovery and page cursor survive alarm budgets; complete five-page turn and all actions fit the budget; page shifts completed by the next full pass; failed page retried without holding already queued routes; disconnected inbox ignored. |
| Relay holding | Pending bot-inbox customer messages held in one conversation job; status webhook and sweep release them; sweep also wakes jobs outside lookback; open/resolved/snoozed release; disconnect release; one short race re-read then no alarm polling; cursor and notification decisions survive retries. |
| Answering replies | Public outgoing bot/human replies count, including after the first forward page; private, deleted, failed, template, activity and automatic-email messages do not; later real customer request survives automatic email; only open unanswered messages call triage; history/automatic customer email remain silent; per-message decision and notification/source association remain stable. |
| Commands and queue | `/pending` uses the current inbox's account bot and `assignee_type: AgentBot`, refuses a foreign account bot, falls back to plain pending if unlinked; Manage keeps configured kind labels; pending queue entries show the bot marker without pings/escalation. |
| Existing relay regressions | Discord rate limits/retry/deduplication, pagination and recovery, delivery-failure updates, webhook/command validation, drafts/cards, mention controls, formatting, queue budgets, configuration, and storage migrations. |

Tests tied exclusively to removed attributes, checkpoints, cutover ids or the superseded snooze-on-greeting
contract were replaced by native lifecycle scenarios rather than preserving obsolete expectations.

## Commands and results

All npm, Vitest and cf commands ran in disposable Docker `node:24` containers, with 2 CPUs, 3 GiB memory,
`CI=1`, and `CLOUDFLARE_TELEMETRY_DISABLED=1`. Each container first ran `npm install -g npm@12.1.0`.
Only the assigned worktree was mounted; external service interactions in tests were mocked.

```sh
npm ci
npm exec -- biome check --write .
npm run lint
npm run typecheck
npm test
npm run build
(cd packages/chatwoot-discord-relay && ../../node_modules/.bin/cf deploy --prebuilt --dry-run)
(cd packages/chatwoot-router && ../../node_modules/.bin/cf deploy --prebuilt --dry-run)
npm run check:package
```

The install and complete verification sequence exited 0. The final production revision passed the sequence
again without reinstalling unchanged dependencies. Six additional router regression cases were then added;
format, lint, root/both-package typechecks and the entire router suite were rerun and exited 0. No production
code changed after the successful build/dry-run/package checks.

```text
npm ci: added 116 packages, audited 133 packages
lint: Checked 116 files. No fixes applied.
typecheck: root, both Workers, Node entry points: exit 0
root documentation test: 1 passed
relay: 14 test files, 278 tests passed
router (final regression run): 4 test files, 101 tests passed
cf build: both packages succeeded
relay dry-run: Total Upload 737.52 KiB / gzip 164.23 KiB; Dry run complete
router dry-run: Total Upload 304.43 KiB / gzip 73.15 KiB; Dry run complete
package checks: exit 0 for both packages
git diff --check: clean
```

`check:package` packed both packages, installed each tarball into an isolated consumer, compiled the Node and
Worker consumers, checked each installed CLI's usage/exit status 2, and ran `npm pkg fix --workspaces` followed
by byte-for-byte manifest comparison. Both manifests remained unchanged.

Two non-blocking dependency notices were present: npm's install audit reported **6 vulnerabilities (1 moderate,
5 high)** in the existing dependency tree, and `discord-interactions` reported missing sourcemap source files.
Dependency manifests and the lockfile were not changed; dependency remediation is outside this migration.

## Operational boundaries

Chatwoot contracts were checked against the v4.18.0 raw source paths listed in [the design](agent-bot.md).
Published OpenAPI omissions are handled narrowly at the shared API boundary; no generated schema was edited.

The API cannot atomically condition a mutation on the preceding read. A lost status webhook plus a permanently
deleted, never-observed activity cannot reconstruct a turn. Observed missing/deleted/incomplete boundaries
hand off; persistent permission or upstream failures require repair before handoff can succeed. A failed or
unknown canned reply attempt is intentionally not resent and can therefore produce no delivered reply.

Release operators must deploy relay first, stop the old router webhook/cron, replace router in place preserving
DO state/reply records, then connect bots account by account. The user token must see every routed inbox.
Keep old Chatwoot attributes through the rollback window; disconnect bots before restoring old routing.
An inactive but linked association is still sweep scope because the inbox API has no active flag.
