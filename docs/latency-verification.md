# Latency changes and verification

Baseline: `08e2291`, after #108. Work was confined to the `latency` workspace and branch.
Verification completed on October 3, 2026 (PDT), using disposable `node:24` Docker containers
with `npm install -g npm@12.1.0`. No production services, credentials, deployments or publishing
were used. All commits are local and carry the requested co-author trailer.

## Design by audit finding

| Finding | Result |
| --- | --- |
| L1: initial interaction response | One 2.5-second budget covers configuration, bounded body reading, signature verification and one Hub RPC. The Hub performs local ticket/draft lookup and durable command enqueue. Only confirmed enqueue permits an action ACK. An unknown enqueue returns HTTP 503 with instructions to check Chatwoot. Draft modals use persisted drafts; a miss immediately offers Reply with this. No defer-then-modal flow. |
| L2: coordination unit | Router state belongs to the `accountId:conversationId` Durable Object: queue, decision memo, turn guards and permanent reply records have one writer. A separate `Coordinator` pages pending/open account conversations and enqueues their conversation objects. Webhooks go directly to their conversation object. Relay retains its deployed global `Hub`. |
| L3: operation and job deadlines | Metadata reads/writes have 1.5-second deadlines; uploads/downloads have 8-second deadlines, including response bodies. Caller, operation and Relay job signals compose. Relay jobs have 10-second slices and retain message parts, cursors, digest pages and completed command attachments before continuation. Mutations reserve a full operation deadline. Pre-dispatch exhaustion permits continuation; in-flight unknown sends retain permanent attempt guards. Completed attachments are stored in bounded SQL chunks and expire after one hour. |
| L4: limits across alarms | Discord bucket cooldowns persist by bucket, major resource and auth scope. Bot and unauthenticated global limits are separate; original-response/follow-up interaction routes honor their route limits without inheriting bot global limits. Discord and Chatwoot Retry-After become persisted not-before schedules. No rate-limit sleep or retry loop occupies an alarm. |
| L5: useful work first | Confirmed feedback precedes commands; live messages/card work precedes sweep pages. Jobs gain one priority level every 30 seconds, preserving background progress. An hourly digest invocation reads at most two independent account/status pages, persists its snapshot/cursors/successful parts and checks the three-minute deadline before reading and posting. Existing nonce and escalation commit order remains. |
| L6: immediate visible state | Conversation changes enqueue immediate live status/card sync separately from delayed activity-line completion. Pending hold, its race re-read and sweep/event wakeups retain their existing semantics. No product timeout is added to greeting turns. |
| L7: action, feedback and card | A command persists its started marker and confirmed result. Result PATCH and card convergence are separate durable retryable jobs. Retrying feedback has no execution path back to the Chatwoot action. Unknown action outcomes are reported without automatic replay. Confirmed feedback has priority over attachment continuation. |
| L8: fresh preparation | Router combines side-effect-free preparation and uses message pages from the same fresh phase for reply history. Mutations still require fresh ownership/turn/reply checks. Relay reuses a freshly read short page for answered evidence while preserving message-update invalidation and final-page re-reading across alarms. Decision memo identity includes actual redacted input and routing configuration/model. |
| L9: bounded independent reads | Menus/panels, webhook discovery, routing preparation and digest chains use two or three independent reads. All reads settle before yielding. Dependent historical pages, message parts, assignments and state mutations remain ordered and every outbound attempt counts toward the invocation budget. Attachment downloads remain sequential within the byte/memory limits. |
| L10: decorative metadata | Inbox names and avatars use cache-aside durable refresh jobs, a 300 ms refresh deadline, negative caching and immediate fallback. Their misses do not block a customer body. Permissions, bot bindings, pending/blocked state, turn boundaries and absence of replies are never cached as authorization or correctness evidence. |

Router exports/bindings and README now include both `Router`/`ROUTER` and
`Coordinator`/`COORDINATOR`. Router 0.2.x was never deployed, so no state migration is needed;
the CHANGELOG states this explicitly. Relay keeps its original Hub namespace, mappings, cursors,
held jobs and existing schema. Its command attachment table and assignee-notice receipt column
are additive; no existing state moves or dual writers are introduced.

Execute Webhook provides no idempotency key. New posts, message parts, derived responses and
notices therefore retain attempt/receipt records. Derived responses have a revision per source
message, allowing a valid A → B → A rating change to produce three messages. Assignee notices
commit before the best-effort member PUT. Cards retain their existing unknown-card history
recovery, and hourly digest sends retain their documented nonce-based retry boundary.

## Preserved correctness contract

- Chatwoot remains the status/ownership authority. Exact account+brand-bot identity,
  AgentBot/User distinction, human takeover, bot disconnect, blocked and can_reply checks stay live.
- Turn boundaries still handle missing, deleted and delayed activities without trusting old
  webhook payloads or updated_at. Three failures preserve durable handoff. Ending a turn releases
  only the same brand bot and preserves other owners/statuses.
- Reply attempted/observed records survive later turns and deletion. Only a valid public bot
  creation receipt for that conversation or confirmed history permits resolved/snoozed ending.
  Failed, malformed and unknown outcomes never authorize another reply or ending; channel
  delivery failure still produces its warning.
- Relay retains pending hold, complete ordered message parts and cursor commits, answered
  eligibility, final-page re-reading across alarms and immediate message_updated invalidation.
- Notification decisions and per-conversation/global budgets remain once-per-message. Card/draft
  ownership, deletion recovery and the unarchive → card → archive sequence remain intact.
- Signatures, account permissions, interaction deduplication, privacy and logging rules remain.
  Failed jobs retain their backoff when new events arrive. History uncertainty still hands off.

Existing regression scenarios for these invariants passed alongside the new slow/failing
upstream scenarios.

## Controlled latency measurements

These are single local wall-clock samples through Worker/DO alarms with upstreams replaced at
the fetch boundary, not production p95/p99. Queue age is durable enqueue → first upstream read
for the target job. First action/post/feedback is enqueue → the corresponding observed HTTP
request. Times include local alarm dispatch and processing.

| Controlled scenario | Queue age before → after | First visible request before → after |
| --- | --- | --- |
| Router: conversation A GET waits 1,000 ms; independent B routes/hands off | 996 → 74 ms | First B status action: 1,019 → 103 ms |
| Relay: A GET waits 4,000 ms; another person resolves B | 3,982 → 1,471 ms | Interaction feedback: 3,988 → 1,503 ms |
| Relay: cold inbox-name GET waits 4,000 ms | 42 → 29 ms | First customer body post: 4,077 → 72 ms |

Before samples use baseline production source `08e2291`; after samples use the final source.
Baseline probes restored source in the same task workspace with a finally block, retaining the
signal-aware fetch fixture, and restored all files afterward. No separate repository checkout
was created. The thresholds in the final tests are 500 ms for independent Router action and
decorative-lookup body posting, and 2,000 ms for Relay feedback behind a slow metadata read.

Additional observable checks passed:

- Two 5.5-second attachment downloads cross job slices. The completed first file, larger than a
  SQLite row's 2 MiB limit, downloads once; the interrupted second downloads twice. The final
  multipart request preserves file order and sends once. Another person's feedback arrives
  within the asserted 11-second slice-plus-scheduling bound.
- A 60-second Discord 429 yields immediately; another command's feedback arrives within 500 ms.
  Persisted cooldowns survive client recreation and keep independent major resources separate.
- Failed feedback retries while the card converges, with exactly one Chatwoot action.
- Lost Chatwoot creation and Discord derived-response receipts do not cause re-sends.
- Slow response bodies, caller cancellation and slice exhaustion are bounded. A deadline before
  dispatch resumes safely; a deadline during dispatch preserves the unknown outcome.
- A slow interaction RPC returns before the asserted 2.9-second bound with HTTP 503 and no
  premature ACK. Persisted draft/missing-draft paths and existing modal scenarios still pass.
- Existing routing sweep paging/page shifts, retry isolation, held-job recovery, message-update
  races, message continuation and reply-integrity scenarios all pass.

Relay continues to have one Hub writer. Slow transfers yield at job boundaries; platform alarm
dispatch, queue backlog, upstream failures and intentional pending holds still affect business
completion. Unknown remote outcomes require checking the remote state, rather than replaying a
send. Chatwoot has no atomic compare-and-write API, so its documented mutation race remains.

## Verification

All npm, cf and Vitest execution took place inside disposable Docker containers.

| Check | Result |
| --- | --- |
| npm ci --no-audit --no-fund | Passed |
| npm run lint | Passed |
| npm run typecheck, including cf generated types | Passed for root and both packages |
| npm test | Passed: Relay 277, Router 154, root documentation 1; total 432 |
| npm run build | Passed: both cf builds |
| cf deploy --prebuilt --dry-run | Passed for both packages; no upload/deployment |
| npm run check:package | Passed: both packs, consumer installation, Node/Worker consumer tsc, bins returning usage exit 2 |
| npm pkg fix --workspaces | Both manifests compare byte-for-byte clean, checked by check:package |
| git diff --check and manifest/lockfile comparison | Passed; no manifest/lockfile changes |

The first full run exposed a test that required exactly 60,000 ms of remaining Retry-After
despite 1 ms of real processing. The assertion now verifies the remaining cooldown and the
immediate-return bound; the final full run passed. Existing tool warnings are the
discord-interactions missing-source sourcemap and cf's workspace auto-configuration notice.

Generated dependencies/builds/caches and package-check scratch directories were cleaned after
verification. Containers used --rm; no services or persistent volumes were created.

## Production line changes

Raw git added/deleted lines relative to `08e2291`, counting package src directories and shared
production source, excluding tests, documentation, fixtures, generated output and package scripts.
Shared source is listed separately and is not counted twice.

| Source | Added | Removed | Net |
| --- | ---: | ---: | ---: |
| chatwoot-router/src | 172 | 81 | +91 |
| chatwoot-discord-relay/src | 803 | 359 | +444 |
| shared production | 127 | 20 | +107 |

Removed the Router's global routing/sweep coupling, Discord sleep/retry loops, upstream draft
fallback and redundant read-only/fresh-history work. Added conversation coordination, bounded
operation primitives, persisted limiter/continuation state, independent command result jobs and
send guards. The additions implement the required durable state rather than introducing a
separate compensating worker or changing pending product semantics.

## Local implementation commits

- `22a8692` — Partition router state by account and conversation.
- `463b220` — Bound relay jobs and persist independent command feedback.
- `db05021` — Reuse fresh routing reads and document bounded background work.
- `eeebe7f` — Preserve send outcomes across deadlines and prioritize confirmed feedback.

This report is committed separately as the final verification step.
