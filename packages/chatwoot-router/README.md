# chatwoot-router

A native Chatwoot agent bot that uses [TypeSafe Jev](https://docs.typesafe.ai) to assign owners, add topic and
kind labels, send canned responses, and resolve or snooze tickets. Runs on Cloudflare Workers independently
of [chatwoot-discord-relay](https://github.com/Phala-Network/chatwoot-workers/tree/main/packages/chatwoot-discord-relay). The Workers coordinate through Chatwoot status.

## How it works

Chatwoot owns the lifecycle: a conversation is the bot's while pending, and people's otherwise.

- Each routed account has a configured brand bot. Routing is limited to inboxes linked to that exact account's
  bot, discovered through `GET inboxes/{id}/agent_bot`. The user token must see every routed inbox. Disconnecting
  an inbox stops routing. The API does not expose whether the association is inactive; disconnect to disable it.
- Signed bot webhooks at `/chatwoot/agent-bot` enqueue a deduplicated conversation job. The five-minute sweep
  lists **pending** conversations without an age cutoff. Inbox discovery and page cursors persist across alarms
  within the request budget. Failed pages retry. An empty page ends a pass; the next starts at page 1 and catches
  conversations skipped by changing pages. Neither event payloads nor sweep rows are decision inputs.
- Read messages newest-first, unfiltered (including activities), with `before` paging, at most five pages of 20.
  The latest `conversation_status_changed` activity begins the turn; without one or evidence it is missing, use
  the conversation's start. Take the first three usable customer texts after the boundary, oldest first. Include
  email subjects and reply text without quoted history; omit automatic email, deleted messages and private notes.
  Redact identifiers and contact names, then cap the input at 1,600 characters. Memoize Jev's decision by input ids.
- Status activity is asynchronous. The queue's boundary guard remembers an observed/expected transition and the
  last boundary needed to reject stale handoff work. An expected activity not yet present retries normally; an
  incomplete read or a deleted known boundary hands off. Permanently missing activity uses the same three-attempt
  limit. Chatwoot exposes no turn API: a lost webhook plus permanently removed, never-observed activity cannot be
  reconstructed. A late activity ordered after new text does not license reading old text across the boundary.
- Jev chooses owner, topic, kind and whether there is a request. A confident kind takes precedence; otherwise a
  confident greeting/no-request stays pending while fewer than three texts exist. Empty or identifier-only input,
  three greetings, an unclear owner with an actual request, or a public human reply hands off. Blocked contacts
  and person-assigned conversations are untouched. Bot and user assignees are distinguished by `assignee_type`.
- Before **each** action, re-read the inbox link, pending status, assignee, turn boundary, inputs and public human
  replies. A changed input defers the job to decide again. Apply topic/kind labels, then the kind's canned reply,
  then exactly one ending action: the kind's resolved/snoozed status, a confident owner's assignment, or explicit
  bot `status=open` handoff. Preserve human topic labels. Successful person assignment ends the turn; nothing
  follows it. Reopened resolved conversations can lack a bot assignee, in which case assignment would not open
  pending: use native handoff instead. Chatwoot has no atomic compare-and-write API for a change racing a mutation.
- Only canned replies have an action record, `reply:<account>:<conversation>`, kept across turns and upgrades.
  Record it **before sending**: a failure or unknown outcome is never resent. Labels, assignment and status use
  current Chatwoot state, without an effects ledger or custom coordination attributes. A missing canned response
  hands off immediately. After three processing failures (initial, +5s, +10s), persist handoff mode. Further retries
  only revalidate the turn and hand off, with backoff capped at 30 minutes. Handoff failures keep the job; deleted
  conversations and disconnected inboxes end it. Credentials/service failures need repair before handoff can succeed.
- A Worker 2xx means the job is durable, not that routing succeeded. Chatwoot's own webhook failure fallback cannot
  cover later alarm failures. Its fallback opens pending on message-event delivery failure unless
  `keep_pending_on_bot_failure` is enabled; it may leave a bot assignee on open. The relay shows that as unassigned.
  Irrelevant valid bot events are acknowledged. There is no router account-webhook endpoint.

After handoff, later customer messages belong to people. Resolved tickets reopen pending in an active bot inbox
and are decided on their **new turn's** messages. Snoozed tickets reopen open and go to people. A canned reply
following a customer message counts as answering it in the relay, even if that message was outside Jev's window.

## Deploy

Use Node 24 (24.15 or newer), npm 12.1.0, and the Cloudflare CLI `cf`. From this repository, run inside Docker:

```sh
npm ci
cd packages/chatwoot-router
npm run typecheck
npm test
npm run build
npx cf deploy --prebuilt --dry-run
```

Edit `cloudflare.config.ts` with your non-secret settings. Keep required secrets out of source control;
`.dev.vars.example` lists placeholders. For local development copy it to `.dev.vars` and use `npm run dev`.
A maintainer deploys with `npx cf deploy --secrets-file <private-file>`.
The default Worker name is `chatwoot-router`; it exports one SQLite Durable Object, `Router`, bound as `ROUTER`.
Keep the `*/5 * * * *` cron trigger for reconciliation. `GET /healthz` returns 200 for a valid, readable
configuration and 503 otherwise; it does not test upstream credentials or connectivity.

For a private deployment repository, depend on the public `chatwoot-router` npm package plus `cf`, Vite, and
`@cloudflare/vite-plugin`. Its Worker entry is:

```ts
export { default, Router } from "chatwoot-router";
```

Use the same `cloudflare.config.ts` and `vite.config.ts` structure as this package. Pin compatible tooling versions
from the workspace and root manifests. Declare `Router` with `exports.durableObject({ storage: "sqlite" })`, bind it as
`ROUTER`, declare required secrets with `bindings.secret()`, and put `CONFIG` in `bindings.json(...)`.

For a configuration larger than a Worker JSON binding, use immutable KV configuration instead:

```sh
npx cf kv namespaces create --title chatwoot-router-config
npx chatwoot-router-store-config config.jsonc --namespace-id <namespace-id>
```

```ts
import { storedConfig } from "chatwoot-router/stored-config";
```

Set `CONFIG_STORE: bindings.kv({ id: "<namespace-id>" })` and
`CONFIG_KEY: bindings.text(storedConfig("config.jsonc").key)` in the Worker's `env`, removing `CONFIG`.
The CLI validates JSONC, uploads through the deployment project's `cf`, and prints the content-addressed key.
Keep older keys for rollbacks. The JavaScript and type declarations in each npm tarball are self-contained;
no unpublished shared package needs installing.

## Chatwoot setup

1. Give `CHATWOOT_TOKEN`'s user access to every routed inbox (membership or account administrator).
2. Create a brand agent bot in each account. Set its webhook URL to `https://<router>/chatwoot/agent-bot` and put its
   id in `routing.botIds`, access token in `CHATWOOT_AGENT_BOT_TOKENS`, and bot webhook secret in
   `CHATWOOT_AGENT_BOT_SECRETS`. All three maps must name exactly the routed accounts. Account webhook secrets
   are different credentials. Bot signatures use HMAC-SHA256 of `<timestamp>.<raw body>`, a ±5-minute window,
   and account matching. Valid irrelevant events are acknowledged without actions.
3. Create topic and kind labels and any canned responses in Chatwoot. Canned responses use their short codes and
   are read at send time; customers see the brand bot's name. Chatwoot expands its normal message variables.
4. After deploying both Workers, connect each bot to the inboxes it routes. No `routing_*` custom attributes or
   definitions are needed. For the relay's Manage card, list every kind name in `router.keepLabels`.

These contracts were checked against [Chatwoot v4.18.0 source](https://github.com/Phala-Network/chatwoot-workers/blob/main/docs/design/agent-bot.md): assignment service,
conversation/message models, activity job, inbox/bot presenters, message finder and agent-bot listener.

## Configuration reference

`CONFIG` accepts a JSON object or JSON string, or use `CONFIG_STORE` + `CONFIG_KEY` instead. Do not set both.

```json
{
  "chatwoot": { "baseUrl": "https://chatwoot.example.com" },
  "routing": {
    "botIds": { "1": 1 },
    "accounts": {
      "1": {
        "support": { "assignee": 6, "covers": "Product support, billing, and account access." },
        "sales": { "assignee": 7, "covers": "Sales questions and purchase enquiries." }
      }
    },
    "topics": { "billing": "Invoices and payments.", "technical": "Product troubleshooting." },
    "minConfidence": 0.7,
    "kinds": { "1": { "spam": { "covers": "Unsolicited advertising.", "status": "resolved" } } }
  }
}
```

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `chatwoot.baseUrl` | HTTP(S) URL | required | Final Chatwoot API URL; redirects are refused. |
| `subrequestBudget` | integer 45–1000 | `45` | Per-alarm outbound budget; reserve 45 for a bounded turn read and all actions. |
| `routing.model` | non-empty string | `jev-1.13.0` | TypeSafe model. |
| `routing.minConfidence` | number 0.5–1 | `0.7` | Probability an answer needs before it is applied. |
| `routing.botIds` | object: account id → positive safe integer | required | Brand bot id for every routed account, and no others. |
| `routing.accounts` | object: account id → (owner name → owner) | required | Routed accounts and the owners Jev chooses from. Owner names are 1–40 lower-case letters, digits, or `_`; `unclear` is reserved. |
| `routing.accounts.<id>.<name>.assignee` | integer > 0 | required | Chatwoot user id to assign. |
| `routing.accounts.<id>.<name>.covers` | 1–1000 characters | required | What the owner handles: Jev's criterion for choosing them. |
| `routing.topics` | object: label → what it covers | unset | Topic labels (Chatwoot label names, lower case) Jev chooses from; one is added when a ticket has no label other than its kinds (an automation rule's label is kept alone). The separate relay can display them using its `forumTags` configuration. Unset: no topic. |
| `routing.kinds` | object: account id → (kind name → kind) | unset | Kinds of ticket Jev recognizes in routed accounts, added as labels beside the topic, and what is done once when it does ([How it works](#how-it-works)). Kind names are the account's label names (1–40 lower-case letters, digits, `_`, or `-`); `none` is reserved. Unset: none. |
| `routing.kinds.<id>.<name>.covers` | 1–1000 characters | required | What the kind is: Jev's criterion for recognizing it. |
| `routing.kinds.<id>.<name>.cannedResponse` | short code | unset | The account's Chatwoot canned response sent to the customer once, by the account's agent bot (`CHATWOOT_AGENT_BOT_TOKENS`); handoff if it is missing. |
| `routing.kinds.<id>.<name>.status` | `resolved` or `snoozed` | unset | Set instead of routing the ticket (`snoozed`: until the customer's next message), after the reply of a `cannedResponse`; a new customer message reopens it. |

### Secrets

| Secret | Required | Meaning |
| --- | --- | --- |
| `CHATWOOT_TOKEN` | Yes | User token for messages, canned responses, inbox discovery and sweep. Must see every routed inbox. |
| `CHATWOOT_AGENT_BOT_TOKENS` | Yes | JSON object of bot access tokens by account id, e.g. `{"1":"<token>"}`. All mutations use the bot token. |
| `CHATWOOT_AGENT_BOT_SECRETS` | Yes | JSON object of bot webhook secrets by account id, e.g. `{"1":"<secret>"}`. |
| `TYPESAFE_API_KEY` | Yes | TypeSafe Jev API key. |

Both bot-secret maps require nonempty values and exactly the `routing.accounts` keys. Missing/invalid entries
fail startup; `/healthz` returns 503 without credentials in its response. All secrets use `bindings.secret()`.

## Upgrade and rollback

1. Verify user-token inbox visibility and count existing pending tickets. Keep both existing Worker names,
   Durable Object namespaces and reply records. Existing pending tickets will be routed; open tickets stay human-owned.
2. Deploy the new relay first. Remove its `router.accounts` and `router.waitSeconds`; keep every kind name in
   `router.keepLabels`. During the transition existing open tickets can go directly to triage.
3. Stop the old router's account webhook and cron; replace it in place. Never run both routers. Remove
   `startAfterConversationId`, `reconcile`, `routing.snoozeUnclear`, `CHATWOOT_WEBHOOK_SECRETS` and
   `CHATWOOT_BOT_TOKENS` from its configuration. Add `routing.botIds` and the two new required bot secrets.
   The one-time storage migration removes old jobs/checkpoints/non-reply effects and decision memos. Reply records
   survive; the pending sweep reconstructs jobs. The Worker never deletes Chatwoot attributes.
4. Connect the bots one account at a time after both Workers are ready. Keep existing `routing_*` attributes and
   definitions until the owner's rollback window ends, then remove them manually.
5. To roll back, **disconnect bots first**, stop the new router/cron, then restore old code, config and account
   webhook if needed. Do not run old and new routing together. Choose old cutover ids deliberately; retained
   reply records prevent resends, but lifecycle changes already made are not reversible automatically.
   Relay sweeps wake held jobs after disconnect; people can open ordinary pending conversations.

Redaction is best effort, not anonymization: other personal information can still reach TypeSafe. Logs contain
ids and outcomes, never message bodies or credentials. See [SECURITY.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/SECURITY.md),
[CONTRIBUTING.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/CONTRIBUTING.md) and [CHANGELOG.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/CHANGELOG.md). Licensed under [MIT](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/LICENSE).
