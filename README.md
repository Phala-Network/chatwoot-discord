# chatwoot-discord

Mirror [Chatwoot](https://www.chatwoot.com/) conversations into a Discord forum, and work tickets
from Discord with slash commands. Runs on Cloudflare Workers (fits the Free plan) and talks to
Chatwoot only through its official webhooks and REST API, and to Discord only through its HTTP
API and HTTP interactions (no gateway connection).

> _Screenshot placeholder: the forum, filtered by an agent's tag and `open`._
>
> _Screenshot placeholder: a ticket post with the ticket card, replies, and the `/reply` editor._

## What it does

**Relay (Chatwoot → Discord)**

- One forum post per conversation, titled `[<Account> #<id>] <customer> — <subject or first message>`.
  The post opens with a ticket card (channel, inbox, customer email, "Open in Chatwoot" link); every
  message follows as a reply.
- Messages are posted through a bot-managed forum webhook named `Chatwoot`, so each shows its
  sender's name and avatar: customers, agents (`Name · Account`), 🔒 private notes, and activity
  lines (`_Resolved by Sam_`). Templates (greetings, CSAT) are skipped. Mentions are disabled on
  every message.
- Tags (matched by name, case-insensitive; tags missing from the forum are skipped; at most 5):
  the account tag, `open`/`resolved`, the assignee's name or `unassigned`, and the conversation's
  topic custom attribute (`topic` by default).
- Resolving archives the post; a new message or reopening unarchives it. Blocked (muted) contacts'
  messages are not posted.
- A newly assigned agent who is linked in the config is pinged once (`-# Assigned to @name`, only
  that user may be mentioned), which also adds them to the post.
- Optional triage bot: customer messages end with a literal `-# <@bot>` mention (which pings nobody)
  so a bot that only reacts to mentions can pick them up. At most 5 per conversation and 30 in
  total per hour; beyond that, a note replaces the mention. Retries never use up the budget.
- Messages longer than Discord's 2000 characters are split at line breaks, capped at 4 Discord
  messages with a "Message truncated … Full text: <link>" note.
- When a post is created, its URL is stored in the conversation's `discord_thread` custom attribute
  (merged, other attributes untouched), so Chatwoot's sidebar links to the post. If that fails the
  relay continues and the error is reported.
- A post deleted in Discord is recreated on the next message. A message that still fails after 5
  attempts is skipped with a ⚠️ notice in its post.

**Commands (Discord → Chatwoot)**, used inside a ticket post:

| Command | Effect in Chatwoot |
|---|---|
| `/reply` | Editor with a message field and an optional upload field; sends to the customer. An unassigned conversation is assigned to the sender. |
| Apps → **Reply with this** (message menu) | Same editor, prefilled: from the triage bot, the code block after a draft label (`Draft` by default); from anyone else, the last code block or the whole message. |
| `/note` | Same editor, for a private note. |
| `/resolve`, `/reopen` | Change the status. |
| `/assign [agent]` | Assign to yourself or another linked Discord user. |
| `/block` | Chatwoot's "Block contact": resolves, blocks the contact, mutes future messages. |

Every action runs **as the invoking agent** with that agent's own Chatwoot access token, so
Chatwoot applies its permissions and records who did it. The invoker sees an ephemeral
"thinking…" that is replaced by the result. Text typed into a post by humans is never sent to the
customer; only these commands send.

## Architecture

```
Chatwoot ──webhook──▶ Worker ──RPC──▶ Hub Durable Object (SQLite)
Discord ─interaction─▶ Worker ──RPC──▶   │ job queue + alarms
Cron (every 5 min) ──▶ Worker ──RPC──▶   ├─▶ Chatwoot REST API (source of truth)
                                         └─▶ Discord REST API
```

- **The Worker only verifies and enqueues.** `POST /chatwoot/webhook` checks the timestamp (±5 min)
  and `X-Chatwoot-Signature` (`sha256=` + HMAC-SHA256 of `"<timestamp>.<raw body>"`, as sent by
  Chatwoot v4.18.0 `lib/webhooks/trigger.rb`); the secret that verifies the request identifies the
  account, which must match the payload. `POST /discord/interactions` verifies Discord's Ed25519
  signature with `discord-interactions`. Both answer within milliseconds of CPU.
- **Webhooks are a trigger, the API is the source of truth.** An event only queues "sync
  conversation N". The Durable Object fetches the conversation and the messages after its stored
  cursor from Chatwoot's API and relays them in order, then corrects tags and the archived flag.
  Duplicate, reordered, or lost webhooks cannot cause duplicate or missing posts. Deliveries are
  also deduplicated by `X-Chatwoot-Delivery`.
- **One Durable Object ("Hub") holds all state and does all work.** Its SQLite tables hold the
  conversation → post mapping and cursor, the job queue, delivery ids, hourly triage counters, and
  a small cache (webhook, tags, inbox names). A single object is the simplest correct choice:
  work is serialized per conversation (no duplicate posts under concurrent events), the global
  triage budget and the post → ticket lookup need no coordination, and support volumes are far
  below one object's throughput. Requests only write a job row and set an alarm; the alarm drains
  due jobs (commands first), retries failures with exponential backoff (5 s … 30 min), and yields
  to a fresh invocation before it would exceed the 50-subrequest limit.
- **Reconciliation.** A cron trigger queues a sweep per account that lists conversations updated
  since the last sweep (`updated_within`, at least `reconcile.lookbackSeconds`, at most
  `reconcile.maxCatchUpSeconds` after downtime) and queues any whose post is behind or whose
  tags/state differ. Missed webhooks and downtime heal on their own.
- **Commands** are answered in the Worker (modals, validation, refusals) or deferred: the job is
  stored in the Durable Object and run from its alarm, which downloads attachments (only from
  `cdn.discordapp.com`/`media.discordapp.net`, no redirects, size-capped), calls Chatwoot as the
  agent, and edits the original response. Commands run at most once (never retried) so a reply is
  never sent twice.

Discord calls use a small fetch-based client (`src/discord/rest.ts`) that honours `retry_after`
and `X-RateLimit-*`. `@discordjs/rest` was evaluated: its web build runs on workerd, but its request
hook is typed against Node/undici streams and it keeps timers and queues across calls, which does
not fit per-invocation subrequest accounting on Workers.

## Setup

Requirements: Node 24, pnpm (version pinned in `package.json`), a Cloudflare account (Free plan is
enough), a Chatwoot instance (v4.18 or later) reachable from the internet, and a Discord server.

### 1. Discord

1. Create an application at <https://discord.com/developers/applications>; note its
   **Application ID** and **Public Key**, and create a **bot token**. No privileged intents are
   needed (a message command receives its target message's content).
2. Invite the bot with the `bot` and `applications.commands` scopes.
3. Create a **forum channel**. Give the bot *View Channels*, *Manage Threads* (tags, archiving),
   and *Manage Webhooks* (the `Chatwoot` webhook that posts messages) on it.
4. Create forum tags as needed: one per account (its name, or the `tag` set in config), `open`,
   `resolved`, `unassigned`, one per agent (their Chatwoot display name), and one per topic value.
5. Register the commands (run manually, whenever `src/commands/definitions.ts` changes):
   ```sh
   DISCORD_BOT_TOKEN=... pnpm register-commands --application <app id> --guild <guild id>
   ```
6. After deploying, set **Interactions Endpoint URL** to `https://<worker>/discord/interactions`
   (Discord verifies it with a signed ping, so the Worker must be running).

### 2. Chatwoot

1. Create a relay user (e.g. "Discord Relay") that is an agent in every inbox you relay, or an
   administrator, and copy its access token (Profile → Access Token). It only reads, and writes
   the `discord_thread` attribute.
2. In each account, add a **conversation custom attribute** `discord_thread` with display type
   *Link* (key configurable via `relay.linkAttribute`; set it to `""` to disable).
3. In each account, add a webhook (Settings → Integrations → Webhooks) pointing at
   `https://<worker>/chatwoot/webhook`, subscribed to `message_created`, `message_updated`,
   `conversation_created`, `conversation_updated`, and `conversation_status_changed`. Copy its
   secret.
4. Each agent who will use commands creates their own access token; the operator stores it as a
   secret keyed by their Discord user id.

The account must have the API/webhooks feature enabled (it is by default on self-hosted).

### 3. Cloudflare

```sh
pnpm install
cp wrangler.example.jsonc wrangler.jsonc   # fill in ids and CONFIG
pnpm wrangler secret put DISCORD_BOT_TOKEN
pnpm wrangler secret put DISCORD_PUBLIC_KEY
pnpm wrangler secret put CHATWOOT_RELAY_TOKEN
pnpm wrangler secret put CHATWOOT_WEBHOOK_SECRETS   # {"1":"...","2":"..."}
pnpm wrangler secret put CHATWOOT_AGENT_TOKENS      # {"<discord user id>":"<chatwoot token>"}
pnpm wrangler deploy
curl https://<worker>/healthz                        # {"ok":true}
```

For local development copy `.dev.vars.example` to `.dev.vars` and run `pnpm dev`.

Self-hosting without Cloudflare is possible with the open-source
[workerd](https://github.com/cloudflare/workerd) runtime (Durable Objects with SQLite and alarms
are supported); you provide TLS, the cron trigger, and storage persistence.

## Configuration reference

Non-secret settings live in the `CONFIG` var in `wrangler.jsonc` (validated at startup; `/healthz`
returns 503 when invalid):

| Key | Default | Meaning |
|---|---|---|
| `chatwoot.baseUrl` | required | Chatwoot base URL for API calls. |
| `chatwoot.publicUrl` | `baseUrl` | Base URL for dashboard links posted in Discord. |
| `discord.applicationId` | required | Discord application id. |
| `accounts[]` | required | `{ id, name, forumChannelId, tag? }`: Chatwoot account id, the name shown in titles and confirmations, its forum, and its forum tag (default `name`). Accounts may share a forum. |
| `agents[]` | `[]` | `{ discordUserId, email }`: links Discord users to Chatwoot agents (commands, assignee pings, `/assign` targets). |
| `triage.userId` | unset | Discord user id of a triage bot to mention on customer messages. |
| `triage.name` | `Triage bot` | Name used in budget notes. |
| `triage.perConversationPerHour` / `perHour` | `5` / `30` | Mention budgets. |
| `triage.draftLabels` | `["Draft"]` | Labels before the triage bot's draft code block. |
| `relay.maxChunks` | `4` | Discord messages per Chatwoot message before truncation. |
| `relay.topicAttribute` | `topic` | Conversation attribute used as a topic tag. |
| `relay.linkAttribute` | `discord_thread` | Conversation attribute that receives the post URL (`""` disables). |
| `relay.startAfterMessageId` | `0` | Messages with an id at or below this are never relayed (cutover watermark). |
| `relay.maxAttempts` | `5` | Attempts before a message is skipped with a notice. |
| `relay.subrequestBudget` | `45` | Outbound requests per alarm invocation (Free plan limit: 50). |
| `reconcile.lookbackSeconds` | `3600` | Minimum sweep window. |
| `reconcile.maxCatchUpSeconds` | `604800` | Maximum sweep window after downtime. |
| `attachments.maxFiles` | `10` | Files per `/reply` or `/note` (0 hides the upload field). |
| `attachments.maxFileBytes` / `maxTotalBytes` | 25 MB / 50 MB | Size caps (files are held in memory). |

Secrets (Worker secrets, never in config): `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`,
`CHATWOOT_RELAY_TOKEN`, `CHATWOOT_WEBHOOK_SECRETS` (JSON by account id), `CHATWOOT_AGENT_TOKENS`
(JSON by Discord user id), optional `ADMIN_TOKEN` and `SENTRY_DSN`.

## Limits and the Workers Free plan

| Free plan limit | How this service stays within it |
|---|---|
| 10 ms CPU per Worker request | The Worker verifies a signature, parses JSON, and makes one Durable Object call. Very large webhook bodies (e.g. multi-megabyte emails) may approach the limit; if one fails, the next sweep relays it. Bodies over 2 MB are rejected. |
| 50 subrequests per invocation | Alarms count requests and yield before `relay.subrequestBudget`; a message only starts when its worst case fits. |
| 128 MB memory | Attachments are capped at 25 MB each / 50 MB per command (the previous relay allowed 10 × 40 MB). |
| 100,000 Worker requests/day | See the estimate below. |
| Durable Objects (SQLite): 100,000 requests/day, 100,000 rows written/day | See the estimate below. |
| 5 cron triggers | One is used. |

Estimate for a busy support desk: **1,000 Chatwoot messages and 200 commands per day**.
Chatwoot sends about 2 webhooks per message (message plus conversation update), so about
2,000 webhook requests, 200 interaction requests, and 288 cron runs: **≈2,500 Worker requests/day
(2.5% of the limit)**. Durable Object requests: 2,000 enqueues + ~400 command lookups/enqueues +
288 sweeps + up to ~2,700 alarm runs: **≈5,400/day (5.4%)**. Rows written (index writes included)
are roughly 10–15 per relayed message plus a few per command and sweep: **≈15,000/day (15%)**.
Each relayed message needs about 3–6 subrequests; the budget allows 45 per alarm run.
Durable Object duration is also metered; check Cloudflare's current pricing page for the Free
allowance.

## Security model

- Chatwoot webhooks: HMAC-SHA256 with a per-account secret, verified in constant time (WebCrypto),
  ±5 minute timestamp window, delivery-id dedupe, and the signing account must match the payload.
- Discord interactions: Ed25519 signature verified before parsing; unsigned requests get 401.
- Commands act only for linked users (`agents[]` plus a token in `CHATWOOT_AGENT_TOKENS`); others
  get an ephemeral refusal. The ticket is resolved from the stored post → conversation mapping,
  never from the post title. Chatwoot enforces each agent's own permissions.
- Discord messages are sent with `allowed_mentions` locked down; only a newly assigned agent can
  be pinged.
- Attachments are fetched only from Discord's CDN over HTTPS, without following redirects, with
  size caps.
- Logs carry ids and outcomes only, never message bodies or tokens. Errors shown to users are
  generic; details go to logs and (optionally) Sentry.
- `POST /admin/import` is disabled unless `ADMIN_TOKEN` is set, compares the bearer token in
  constant time, and should be disabled again after use.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Cutover from an existing relay

If posts already exist (for example from an earlier relay), the service must not open a second
post for those conversations.

1. **Recommended: links.** If the previous relay stored each post URL in the conversation's
   `discord_thread` attribute, nothing needs importing. When a conversation without a mapping has
   a link, the service checks that the thread still exists in that account's forum and adopts it.
2. Set `relay.startAfterMessageId` to the last message id the previous relay handled. Adopted and
   imported posts continue after it; new conversations only relay messages after it. (With `0`,
   adopted posts continue after their latest message.)
3. Stop the previous relay, deploy this service, and point the Chatwoot webhooks at it. The
   sweep catches up on anything changed in the meantime.
4. **Fallback: import.** For posts without a link attribute, load the mappings once:
   ```sh
   pnpm wrangler secret put ADMIN_TOKEN   # 32+ random characters
   ADMIN_TOKEN=... pnpm import-state --url https://<worker> --file mappings.jsonl [--after-message-id <id>]
   pnpm wrangler secret delete ADMIN_TOKEN
   ```
   Each line is `{"accountId":1,"conversationId":12,"threadId":"<post id>","lastMessageId":345}`
   (`lastMessageId` optional). Mappings for unknown accounts, or posts already mapped to another
   conversation, are skipped.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # tests run inside workerd (@cloudflare/vitest-pool-workers)
pnpm build                                  # wrangler dry run into dist/
pnpm gen:chatwoot                           # regenerate src/chatwoot/schema.d.ts (Chatwoot v4.18.0 OpenAPI)
```

Chatwoot routes the relay needs that are missing from the published OpenAPI spec are called
through small, documented wrappers in `src/chatwoot/api.ts` (conversation `mute`, and the
`updated_within` filter on the conversation list), each verified against Chatwoot's source at
v4.18.0.

## License

MIT, see [LICENSE](LICENSE).
