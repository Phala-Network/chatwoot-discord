# chatwoot-discord

[![CI](https://github.com/Phala-Network/chatwoot-discord/actions/workflows/ci.yml/badge.svg)](https://github.com/Phala-Network/chatwoot-discord/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Phala-Network/chatwoot-discord/actions/workflows/codeql.yml/badge.svg)](https://github.com/Phala-Network/chatwoot-discord/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Phala-Network/chatwoot-discord/badge)](https://scorecard.dev/viewer/?uri=github.com/Phala-Network/chatwoot-discord)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Mirror every [Chatwoot](https://www.chatwoot.com/) conversation into a Discord forum post, and
answer customers from Discord with slash commands.

**For** support teams that already work in Discord and use Chatwoot as their help desk, and who
want humans and an AI agent to handle tickets together without leaving Discord. It runs on
Cloudflare Workers (the Free plan is enough).

> [!NOTE]
> An independent, community-maintained integration. It is not affiliated with, endorsed by, or
> supported by Chatwoot or Discord.

**Status:** in production use. Versions are `0.x`: per [SemVer](https://semver.org/#spec-item-4),
a minor release may change configuration or setup; the [changelog](CHANGELOG.md) says what to
do when it does.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Phala-Network/chatwoot-discord)

![A Discord forum with one post per Chatwoot conversation, filtered by brand, status, assignee, and topic tags](docs/assets/forum.png)

*Illustration with fictional data.*

## How it works

```
Chatwoot ──webhook──▶ Worker ──▶ Hub Durable Object ──▶ Discord forum post (via webhook)
Discord ─/command───▶ Worker ──▶ Hub Durable Object ──▶ Chatwoot REST API (as that agent)
Cron (every 5 min) ─▶ Worker ──▶ Hub Durable Object ──▶ sweep: repair anything missed
```

- Each conversation gets one forum post, titled `[<Account> #<id>] <customer> — <subject or first message>`.
  It opens with a ticket card (channel, inbox, customer email, phone number on phone channels,
  "Open in Chatwoot" link), and every message follows under its sender's name: customers,
  agents, 🔒 private notes, activity lines.
- Forum tags follow the conversation: account, status (`open`, `pending`, `snoozed`,
  `resolved`), assignee or `unassigned`, topic, priority, and labels. Resolved posts are archived.
- Agents answer inside the post with `/reply`, `/note`, `/resolve`, `/assign`, `/label`, and
  [other commands](#commands). Each runs in Chatwoot as the agent who used it.
- An optional AI agent (a Discord bot) is called on each customer message and posts a draft;
  a human sends it with **Apps → Reply with this**.

## Deploy

You need a Cloudflare account, a Chatwoot instance (v4.18 or later) reachable from the internet,
and a Discord server where you can add an application and a forum channel.

1. [Create the Discord application and forum](#1-discord).
2. [Prepare Chatwoot](#2-chatwoot): a relay user, the link attribute, and each agent's token.
3. [Deploy the Worker](#3-cloudflare) with the **Deploy to Cloudflare** button at the top or from a checkout: the secrets,
   and `CONFIG` in `wrangler.jsonc`.
4. [Connect them](#4-connect): the Discord interactions URL, the commands, and the Chatwoot
   webhooks.

## Design

- **Chatwoot stays the system of record.** Customers, channels, history, and CSAT live in
  Chatwoot; Discord is where the team, people and bots alike, works. One post per conversation
  gives humans and an AI agent the whole ticket in one thread.
- **An AI agent joins without code changes.** Each new customer message ends with a literal
  `<@bot>` mention of the bot set in `triage.userId`. Discord bots commonly react to other bots'
  messages only when mentioned inline, so the agent wakes up for customer messages and nothing
  else: agent replies, private notes, and activity lines carry no mention. The relay's
  `allowed_mentions` suppresses the notification, so the token pings no human.
- **Cost and abuse are bounded.** At most `triage.perConversationPerHour` (5) customer messages
  per conversation and `triage.perHour` (30) in total call the agent each hour; beyond that a
  visible note replaces the mention. Messages from blocked contacts are never relayed.
- **The AI drafts, humans send.** Talking in a post never reaches the customer; only commands do.
  The agent writes its proposed reply as a fenced code block after a draft label
  (`triage.draftLabels`, default `Draft`). A human uses **Apps → Reply with this** to open the
  reply editor prefilled with it, edits if needed, and submits. Every action runs with the
  human's own Chatwoot token, so Chatwoot's permissions and audit trail apply.
- **Links work both ways, for machines too.** The post URL is stored in the conversation's link
  attribute (`relay.linkAttribute`, default `discord_thread`), so anything that reads Chatwoot's
  API (for example a queue digest) can link to the post; the ticket card links back to Chatwoot.
- **Reliable by construction.** Chatwoot sends each account webhook once, with a short timeout
  and no retry (`lib/webhooks/trigger.rb` at v4.18.0), so webhooks are only triggers. The Worker
  verifies and queues the work durably in one Durable Object and answers at once; the Durable
  Object reads Chatwoot's API, the source of truth; a sweep every 5 minutes repairs anything
  missed.

To connect an AI agent, see [Connecting an AI agent](docs/ai-agent.md).

## Contents

- [Setup](#setup)
- [Commands](#commands)
- [Relay details](#relay-details)
- [Configuration reference](#configuration-reference)
- [Limits and the Workers Free plan](#limits-and-the-workers-free-plan)
- [Security model](#security-model)
- [Internals](#internals)
- [Installing on an existing Chatwoot](#installing-on-an-existing-chatwoot)
- [Cutover from an existing relay](#cutover-from-an-existing-relay)
- [Development](#development)
- [Getting help](#getting-help)

## Setup

### 1. Discord

1. Create an application at <https://discord.com/developers/applications>; note its
   **Application ID** and **Public Key**, and create a **bot token**. No privileged intents are
   needed.
2. Invite the bot with the `bot` and `applications.commands` scopes.
3. Create a **forum channel**. Give the bot *View Channels*, *Manage Threads* (tags, archiving),
   and *Manage Webhooks* (it creates a webhook named `Chatwoot` that posts the messages).
4. Create the forum tags you want (names up to 20 characters; missing tags are skipped): one per
   account (its name, or its `tag`), one per status (`open`, `pending`, `snoozed`, `resolved`),
   `unassigned`, one per agent (their Chatwoot `name`), one per topic value, and any priorities
   (`urgent`, `high`, `medium`, `low`) and Chatwoot labels you want to see. A forum has at most 20
   tags. If the forum's **Require tags** setting is on, make sure every post matches at least one
   tag (for example the account tag), or Discord rejects the new post.

### 2. Chatwoot

1. Create a relay user (e.g. "Discord Relay") that is an agent in every relayed inbox, or an
   administrator, and copy its access token (Profile → Access Token). It only reads, and writes
   the link attribute.
2. In each account, add a **conversation custom attribute** `discord_thread` with display type
   *Link* (or set `relay.linkAttribute` to another key, or `""` to disable).
3. Each agent who will use commands creates their own access token.

The account must have the API/webhooks feature enabled (it is by default on self-hosted).

### 3. Cloudflare

The secrets are described in [`.dev.vars.example`](.dev.vars.example). Use `{}` for
`CHATWOOT_WEBHOOK_SECRETS` until step 4, and `{"<discord user id>":"<chatwoot token>"}` for
`CHATWOOT_AGENT_TOKENS`.

**With the Deploy to Cloudflare button** ([how it works](https://developers.cloudflare.com/workers/platform/deploy-buttons/)):

1. Select the button under [Deploy](#deploy). Cloudflare copies this repository to your GitHub or
   GitLab account, asks for the Worker name and each secret, and deploys with
   [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), which then deploys
   every push to your copy. Keep the detected commands: `npm run build` (a wrangler dry run) and
   `npm run deploy`.
2. In your copy, replace the placeholder `CONFIG` in `wrangler.jsonc` (see the
   [configuration reference](#configuration-reference)) and push; Workers Builds deploys it.
3. Change a secret later in the Cloudflare dashboard (your Worker > **Settings** >
   **Variables and Secrets**) or with `npx wrangler secret put <NAME>` from a checkout.

**From a checkout.** Requirements: Node 24 (24.15 or later) and npm (the version in
`packageManager` in `package.json`).

```sh
npm ci
# Replace the placeholder CONFIG in wrangler.jsonc (see the configuration reference).
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put CHATWOOT_RELAY_TOKEN
npx wrangler secret put CHATWOOT_WEBHOOK_SECRETS   # {} for now; filled in step 4
npx wrangler secret put CHATWOOT_AGENT_TOKENS      # {"<discord user id>":"<chatwoot token>"}
npm run deploy
```

Either way, check the Worker: `curl https://<worker>/healthz` answers `{"ok":true}`, or 503 while
`CONFIG` or a secret is invalid; the reason is in Workers Logs.

Self-hosting without Cloudflare is possible with the open-source
[workerd](https://github.com/cloudflare/workerd) runtime (Durable Objects with SQLite and alarms
are supported); you provide TLS, the cron trigger, and storage persistence.

### 4. Connect

1. In the Discord application, set **Interactions Endpoint URL** to
   `https://<worker>/discord/interactions`. Discord verifies it with a signed request, so the
   Worker must be deployed first.
2. Register the commands in your server (again whenever `src/commands/definitions.ts` changes),
   from a checkout after `npm ci`:
   ```sh
   DISCORD_BOT_TOKEN=... npm run register-commands -- --application <app id> --guild <guild id>
   ```
3. In each Chatwoot account, add a webhook (Settings → Integrations → Webhooks) for
   `https://<worker>/chatwoot/webhook`, subscribed to `message_created`, `message_updated`
   (deleted messages, responses to interactive messages, and replies that could not be
   delivered), `conversation_updated` (assignee, topic, priority, and labels), and
   `conversation_status_changed`. Then store the webhook secrets by account id,
   `{"<account id>":"<webhook secret>"}`, in the `CHATWOOT_WEBHOOK_SECRETS` secret.

## Commands

Used inside a ticket post, by Discord users linked in `agents[]` who have a token in
`CHATWOOT_AGENT_TOKENS`:

| Command | Effect in Chatwoot |
|---|---|
| `/reply [message] [attachment]` | Without options, an editor with a message field and an optional upload field; with either option, sends it at once. Sends to the customer; an unassigned conversation is assigned to the sender. Refused when the channel does not accept a reply (Chatwoot's `can_reply`, e.g. after WhatsApp's 24-hour window). |
| Apps → **Reply with this** (message menu) | The `/reply` editor, prefilled: from the triage bot, the code block after a draft label; from anyone else, the last code block or the whole message. |
| `/note [message] [attachment]` | Like `/reply`, for a private note. |
| `/resolve`, `/reopen` | Change the status. |
| `/pending` | Like Chatwoot's "Mark as pending". |
| `/snooze [until]` | Snooze until the next reply (default) or for an hour. A reply from the contact always reopens it. |
| `/priority <level>` | Set the priority (`Urgent`, `High`, `Medium`, `Low`), or clear it with `None`. |
| `/assign [agent]` | Assign to yourself or another linked Discord user. |
| `/unassign` | Remove the assignee, like choosing "None" as the assignee in Chatwoot. |
| `/label add <label>`, `/label remove <label>` | Add one of the account's labels, or remove one of the conversation's; the other labels stay. |
| `/block` | Like Chatwoot's "Block contact": resolves the conversation and blocks the contact, so their future messages are muted. |
| `/unblock` | Like Chatwoot's "Unblock contact": their new messages are posted again (messages received while blocked are not). The status is unchanged. |

The invoker sees an ephemeral "thinking…" that is replaced by the result. A slash command's
`message` option is a single line of text and `attachment` is one file: use the editor (no
options) for multi-line text or several files. Chatwoot's other
snooze options reopen at a time of day in the agent's browser time zone, which Discord does not
share; use Chatwoot for those. Discord does not allow commands in an archived post: in a resolved
post, first send any message, which unarchives it. The relay archives it again on its next update
while the conversation is resolved.

## Relay details

- Messages are posted through the forum webhook, so each shows its sender's name and avatar:
  customers (their Chatwoot avatar or `avatars.contact`), agents as `Name · Account`, and
  everything else as `Chatwoot` (`avatars.chatwoot`). Templates (greetings, CSAT) are skipped.
- An agent's replies and notes show the Discord avatar of the agent's linked Discord user
  (`agents[]`), else the agent's Chatwoot avatar, else `avatars.chatwoot`. The bot looks each
  linked agent up at most once a day (one extra Discord request); if that fails, it uses the
  fallback and tries again an hour later. Agent bots keep `avatars.chatwoot`.
- Tags are matched by name, case-insensitively. Discord applies at most 5 per post, taken in
  this order: account, status, assignee, topic, priority, then labels. The assignee tag is the
  agent's Chatwoot `name`; the topic tag is the conversation's `topic` custom attribute
  (`relay.topicAttribute`). A resolved conversation's post is archived; any other status
  unarchives it. The forum's tags are read at most every 10 minutes; when Discord refuses a
  request because a tag was deleted since, it is sent again with the tags read anew.
- The post title follows the contact's name when it changes (on the conversation's next sync);
  posts adopted from another relay or created by earlier versions keep their title.
- A newly assigned agent who is linked in `agents[]` is pinged once, in a `-# Assigned to @name`
  notice after the live messages that came with the assignment (after the last one, when the
  conversation was reassigned several times in a row). After that, every customer message pings
  the linked assignee, on the same line as the triage mention. A linked agent @mentioned in a private note is pinged there; other Chatwoot mentions
  show as `@name`. Nothing else pings anyone.
- Notification lines (the triage mention, pings, budget notes) go on the last Discord message of
  a split message, so a bot they call sees all of it. Only live messages carry them: messages
  created more than `reconcile.lookbackSeconds` ago (the history of an older conversation, or a
  catch-up after downtime) are posted without them.
- Messages longer than Discord's 2000 characters are split at line breaks, at most
  `relay.maxChunks` (4) Discord messages, then a "Message truncated … Full text: <link>" note.
- An email is posted without the earlier emails it quotes, as Chatwoot itself forwards it (its
  processed content: the reply part of the text body, else of the HTML body). An automatic
  reply (Chatwoot's `auto_reply` flag, from the `Auto-Submitted` or `X-Autoreply` header) is
  posted without notifications.
- Shared contacts and locations, which have no file, are shown as a 📇 or 📍 line; Instagram
  story mentions and reels, and content a channel could only describe (Chatwoot's `fallback`), as
  a labelled 📎 link; a LINE sticker as its image link. A bot's options, cards, and articles are
  listed with their links.
- Customer text cannot call a bot or pass for the relay's own lines: mention tokens (`<@…>`,
  `<@&…>`, `<#…>`, `</…>`), `@everyone`, `@here`, and a `-#` at the start of a line get a
  zero-width space.
- A message deleted in Chatwoot is deleted from the post once Chatwoot's API confirms it. This
  uses the forum webhook that posted it; if that webhook was deleted in Discord (the relay then
  creates a new one), its messages stay, because the bot has no permission to delete others'
  messages.
- A customer's response to an interactive message (option pick, form, CSAT rating, email
  request) is posted under the customer's name, formatted like Chatwoot's Slack integration. A
  changed response is posted again; an unchanged one is not.
- A reply the channel could not deliver (Chatwoot marks it failed, e.g. outside WhatsApp's
  24-hour window) gets one ⚠️ notice in the post with the channel's reason.
- A conversation deleted in Chatwoot gets a notice in its post, which is archived and forgotten.
  Chatwoot sends no webhook for a deletion (v4.18.0), so this happens when the next event for it
  arrives or a command in the post finds it gone.
- A post deleted in Discord is recreated on the next message. A message Discord refuses as
  invalid (an HTTP 4xx other than 401, 403, 404, 408, and 429) is skipped with a ⚠️ notice in its
  post after `relay.maxAttempts` (5) attempts. Rate limits, Discord server errors, timeouts, and
  missing permissions never skip a message: its job retries until Discord accepts it, and waits
  as long as Discord asks when rate limited.

## Configuration reference

Non-secret settings live in the `CONFIG` var in `wrangler.jsonc`, validated at startup; an
unknown key (for example a typo) makes it invalid. The committed values are placeholders to
replace:

| Key | Default | Meaning |
|---|---|---|
| `chatwoot.baseUrl` | required | Chatwoot base URL for API calls. |
| `chatwoot.publicUrl` | `baseUrl` | Base URL for dashboard links posted in Discord. |
| `accounts[]` | required | `{ id, name, forumChannelId, tag?, inboxIds? }`: Chatwoot account id, the name shown in titles and confirmations, its forum, its forum tag (default `name`), and the inboxes to relay (default: all). Accounts may share a forum. |
| `agents[]` | `[]` | `{ discordUserId, email }`: links Discord users to Chatwoot agents (commands, assignee pings, `/assign` targets, and the Discord avatar on the agent's messages). |
| `triage.userId` | unset | Discord user id of an AI agent (triage bot) to mention on customer messages. |
| `triage.name` | `Triage bot` | Name used in budget notes (at most 100 characters). |
| `triage.perConversationPerHour` / `perHour` | `5` / `30` | Mention budgets. |
| `triage.draftLabels` | `["Draft"]` | Labels before the triage bot's draft code block. |
| `relay.maxChunks` | `4` | Discord messages per Chatwoot message before truncation. |
| `relay.topicAttribute` | `topic` | Conversation attribute used as a topic tag. |
| `relay.linkAttribute` | `discord_thread` | Conversation attribute that receives the post URL (`""` disables). |
| `relay.startAfterMessageId` | `0` | Messages with an id at or below this are never relayed (cutover watermark). |
| `relay.maxAttempts` | `5` | Attempts before a message Discord refuses as invalid is skipped with a notice. |
| `relay.subrequestBudget` | `45` | Outbound requests per alarm invocation (Free plan limit: 50). At least `relay.maxChunks` + 24: a run's setup and one message's worst case (`src/relay/limits.ts`). |
| `reconcile.lookbackSeconds` | `3600` | Minimum sweep window (conversations with activity within it are checked). Messages older than this are relayed without notifications. |
| `reconcile.maxCatchUpSeconds` | `604800` | Maximum sweep window after downtime. |
| `avatars.chatwoot` | `<Chatwoot URL>/favicon-512x512.png` | Avatar of activity lines, cards, notices, agent bots, and agents with neither a linked Discord user nor a Chatwoot avatar (https). |
| `avatars.contact` | Gravatar "mystery person" | Avatar of customers who have no avatar in Chatwoot (https). |
| `attachments.maxFiles` | `10` | Files per `/reply` or `/note` (0 hides the upload field). |
| `attachments.maxFileBytes` / `maxTotalBytes` | 25 MB / 50 MB | Size caps (files are held in memory). |

Secrets (Worker secrets, never in config): `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`,
`CHATWOOT_RELAY_TOKEN`, `CHATWOOT_WEBHOOK_SECRETS` (JSON by account id), and
`CHATWOOT_AGENT_TOKENS` (JSON by Discord user id, optional).

## Limits and the Workers Free plan

| Free plan limit | How this service stays within it |
|---|---|
| 10 ms CPU per Worker request | The Worker verifies a signature, parses JSON, and makes one Durable Object call. Bodies over 2 MB are rejected; a very large webhook that fails is relayed by the next sweep. |
| 50 subrequests per invocation | Alarms count requests and yield before `relay.subrequestBudget`; a message only starts when its worst case fits. |
| 128 MB memory | Attachments are capped at 25 MB each / 50 MB per command. |
| 100,000 Worker requests/day | See the estimate below. |
| Durable Objects (SQLite): 100,000 requests/day, 100,000 rows written/day | See the estimate below. |
| 5 cron triggers | One is used. |

Estimate for a busy desk, **1,000 Chatwoot messages and 200 commands per day**: about 2,000
webhook requests (Chatwoot sends about 2 per message), 200 interaction requests, and 288 cron
runs, **≈2,500 Worker requests/day (2.5%)**; 2,000 enqueues, ~400 command lookups and enqueues,
288 sweeps, and up to ~2,700 alarm runs, **≈5,400 Durable Object requests/day (5.4%)**; roughly
12–18 rows written per relayed message plus a few per command and sweep, **≈18,000/day (18%)**.
Each relayed message needs about 3–6 subrequests. Durable Object duration is also metered; check
Cloudflare's current pricing for the Free allowance.

## Security model

- Chatwoot webhooks: HMAC-SHA256 (`X-Chatwoot-Signature`, `sha256=` + HMAC of
  `"<timestamp>.<raw body>"`) with a per-account secret, verified in constant time (WebCrypto),
  ±5 minute timestamp window, and the signing account must match the payload. A replayed webhook
  only queues a sync, which changes nothing when the post is up to date.
- Discord interactions: Ed25519 signature verified (`discord-interactions`) before parsing;
  unsigned requests get 401.
- Commands act only for linked users; others get an ephemeral refusal. The ticket is resolved
  from the stored post → conversation mapping, never from the post title.
- Discord messages are sent with `allowed_mentions` locked down; only the conversation's linked
  assignee can be pinged.
- Attachments are fetched only from Discord's CDN (`cdn.discordapp.com`, `media.discordapp.net`)
  over HTTPS, without following redirects, with size caps.
- Logs carry ids and outcomes only, never message bodies or tokens. Errors shown to users are
  generic; details go to Workers Logs (`observability` in `wrangler.jsonc`).

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Internals

- **Worker** (`src/index.ts`): verifies requests and hands work to the Hub Durable Object; each
  request uses a few milliseconds of CPU. Commands that need no Chatwoot call (editors,
  validation, refusals) are answered directly; the rest are deferred.
- **Hub Durable Object** (`src/hub.ts`, SQLite): one object holds all state (conversation → post
  mapping and cursor, the Discord message ids posted per Chatwoot message, posted responses, the
  job queue, triage counters, a small cache) and does all work from its alarm. One object keeps
  work serialized per conversation and makes the triage budget and post lookups coordination-free;
  support volumes are far below its throughput. Jobs run by priority (commands first), failures
  retry with exponential backoff (5 s … 30 min), and a run yields before the subrequest limit.
  A job that Discord rate limits waits as long as Discord asks, without counting an attempt.
  A job that fails 10 times (about 70 minutes) is dropped: the sweep queues its conversation
  again while it is behind, and its next webhook starts a new job. Every outbound request times
  out after 60 seconds, which counts as a failed attempt. While a conversation's job is
  backing off, new events for it wait for its next attempt.
- **Relaying** (`src/relay/`): a webhook only queues "sync conversation N" (conversation events
  wait 10 seconds first, for Chatwoot to create the change's activity message, which sends no
  webhook). The job fetches the
  conversation and the messages after its cursor, posts them in order, then corrects tags and the
  archived flag once. Each Discord message is recorded as soon as it is accepted and the cursor
  moves past a Chatwoot message once all its parts are posted, so duplicate, reordered, or lost
  webhooks cause no duplicate or missing posts. The one remaining way to post twice is a request
  Discord accepted whose response never arrived: Execute Webhook has no idempotency key.
- **Sweep**: the cron trigger queues a sweep per account that pages through conversations, most
  recent activity first, back to the last sweep (at least `reconcile.lookbackSeconds`, at most
  `reconcile.maxCatchUpSeconds`, and at most 10 pages), and queues any conversation whose post is
  behind or whose tags or state differ. When it stops at 10 pages, the next sweep reaches back
  to the oldest activity it read. Activity means a new message; a change without one (for
  example only the topic attribute), deletions, and interactive responses rely on their webhooks.
- **Commands** (`src/commands/`): deferred commands run at most once, never retried, so a reply is
  never sent twice; one that cannot start within 12 minutes is dropped, because Discord's
  interaction token (valid 15 minutes) could soon no longer report its result, and the invoker is
  told that nothing was done.
- **Clients**: Discord calls use a small fetch-based client (`src/discord/rest.ts`), typed with
  `discord-api-types`, that follows per-route and global rate limits (`@discordjs/rest` keeps
  timers and queues across calls, which does not fit per-invocation subrequest accounting).
  Chatwoot calls use only routes in Chatwoot's published OpenAPI spec, typed by `openapi-fetch`
  and generated types; messages are validated with zod because the spec's `message` schema does
  not describe the fields the API returns (see `src/chatwoot/api.ts`).

## Installing on an existing Chatwoot

Conversations have no post until their next message; that post then relays the conversation's
whole history (without notifications, see [Relay details](#relay-details)). To start with new
messages only, set `relay.startAfterMessageId` to the newest message id in Chatwoot when you
install (for example the id in the newest conversation's `messages` from
`GET /api/v1/accounts/<id>/conversations`).

## Cutover from an existing relay

If posts already exist (for example from another relay), the service must not open a second
post for those conversations.

1. Store each existing post URL in its conversation's `discord_thread` attribute
   (`https://discord.com/channels/<guild id>/<thread id>`). A conversation without a mapping
   adopts the linked post if it still exists in that account's forum.
2. Set `relay.startAfterMessageId` to the last message id the other relay handled. Adopted posts
   and new conversations only relay messages after it. (With `0`, adopted posts continue after
   their latest message.)
3. Stop the other relay, deploy this service, and point the Chatwoot webhooks at it. The sweep
   catches up on anything changed in the meantime.

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test   # tests run inside workerd (@cloudflare/vitest-pool-workers)
npm run build                                   # wrangler dry run into dist/
npm run dev                                     # local Worker; copy .dev.vars.example to .dev.vars first
npm run types                                   # regenerate worker-configuration.d.ts (runtime types)
npm run gen:chatwoot                            # regenerate src/chatwoot/schema.d.ts (Chatwoot v4.18.0 OpenAPI)
sh docs/assets/render.sh                        # re-render the README illustrations (needs Docker)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and releases, and
[CHANGELOG.md](CHANGELOG.md) for the release history. This project follows the
[Contributor Covenant](CODE_OF_CONDUCT.md).

## Getting help

- Questions and setup help: [GitHub Discussions](https://github.com/Phala-Network/chatwoot-discord/discussions).
- Bug reports and feature requests: [GitHub Issues](https://github.com/Phala-Network/chatwoot-discord/issues).
- Security vulnerabilities: report privately as described in [SECURITY.md](SECURITY.md), not in a
  public issue.
- Chatwoot or Discord behaviour itself: their own documentation and support channels.

## License

MIT, see [LICENSE](LICENSE).

Chatwoot and Discord are trademarks of their respective owners, used here only to describe what
this project works with.
