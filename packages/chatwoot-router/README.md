# chatwoot-router

Route Chatwoot support tickets with [TypeSafe Jev](https://docs.typesafe.ai) on Cloudflare Workers:
assign owners, add topic and kind labels, and optionally send a canned response or resolve/snooze tickets.
Runs independently of [chatwoot-discord-relay](https://github.com/Phala-Network/chatwoot-workers/tree/main/packages/chatwoot-discord-relay).
Neither Worker calls the other: Chatwoot is their only coordination surface.

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

- `CHATWOOT_TOKEN` belongs to an agent in every routed inbox or an administrator.
- In each routed account, add a signed webhook pointing to `POST /chatwoot/webhook`. Subscribe to
  `message_created`, `conversation_created`, `conversation_updated`, and `conversation_status_changed`.
- Put that webhook's secret in `CHATWOOT_WEBHOOK_SECRETS`, keyed by account id. Webhooks use HMAC-SHA256 of
  `<timestamp>.<raw body>`, a ±5-minute timestamp window, and account matching. Only public incoming messages
  whose sender is a contact, and the relevant conversation events, queue routing; the API is re-read before acting.
- Create the topic and kind labels in Chatwoot. Create the following **conversation** custom attribute definitions:

| Default name | Type | Meaning |
| --- | --- | --- |
| `routing_seen` | Number | Latest customer message id processed or skipped, written only after the decision's other actions finish. The sole routing-completion signal. |
| `routing_handled` | Number | Latest customer message id handled by a kind's successful reply or set-aside action. |
| `routing_kind` | Text | Kind label added by the router, preserved by the relay's Manage card. |

Every public incoming contact `message_created` in a routed account queues a completion check, even for an
assigned, closed, pre-cutover, or already-routed ticket. Skipped messages and no-owner decisions also advance
`routing_seen`; only eligible open, unassigned tickets ask Jev. When a kind handles messages, `routing_handled`
and `routing_kind` are included in the same update as `routing_seen`, after its reply/status/label actions.

Attributes are updated through Chatwoot's `custom_attributes` API with `merge: true`. Chatwoot v4.18 implements
this as read-merge-save, not an atomic merge: concurrent relay/router writes can still lose keys. The router
durably records completion watermarks and kind before writing, and repairs missing or older attributes on
subsequent webhooks or sweeps without repeating Jev or replies. It retains the greatest watermarks observed;
unchanged attributes are not written again. The relay similarly repairs its missing or different post URL on sync.
Recovery is eventual, not a cross-Worker transaction. Failed writes retry rather than prematurely finishing the job.
With the relay, set `router.accounts` there; its default wait is 30 seconds from each customer's message time.
Assignment and status changes never release that wait; only `routing_seen` or the timeout does.
Its `router.attributes` must match this package's `attributes` when using custom names.

## Configuration reference

`CONFIG` accepts a JSON object or JSON string, or use `CONFIG_STORE` + `CONFIG_KEY` instead. Do not set both.

```json
{
  "chatwoot": { "baseUrl": "https://chatwoot.example.com" },
  "routing": {
    "accounts": {
      "1": {
        "support": { "assignee": 6, "covers": "Product support, billing, and account access." },
        "sales": { "assignee": 7, "covers": "Sales questions and purchase enquiries." }
      }
    },
    "topics": { "billing": "Invoices and payments.", "technical": "Product troubleshooting." },
    "minConfidence": 0.7,
    "snoozeUnclear": true,
    "kinds": { "1": { "spam": { "covers": "Unsolicited advertising.", "status": "resolved" } } }
  },
  "startAfterConversationId": { "1": 0 }
}
```

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `chatwoot.baseUrl` | HTTP(S) URL | required | Final Chatwoot API URL; redirects are refused. |
| `startAfterConversationId` | object: routed account id → integer ≥ 0 | `{}` | Each account's conversation display id at cutover; omitted accounts default to `0`. At or below it, routing actions and Jev are skipped, but customer messages still advance `routing_seen`. |
| `attributes.seen` | non-empty string | `routing_seen` | Completion watermark for processed or skipped customer messages. |
| `attributes.handled` | non-empty string | `routing_handled` | Handled watermark attribute. |
| `attributes.kind` | non-empty string | `routing_kind` | Kind label attribute. The three names must be distinct. |
| `reconcile.lookbackSeconds` | integer ≥ 60 | `3600` | Minimum activity window for the five-minute sweep. |
| `reconcile.maxCatchUpSeconds` | integer ≥ 60 | `604800` | Maximum activity window after downtime. |
| `subrequestBudget` | integer 20–1000 | `45` | Per-alarm outbound budget; keep under your Workers plan's limit. |
| `routing` | object | required | TypeSafe Jev owner, topic, and kind configuration. |
| `routing.model` | non-empty string | `jev-1.13.0` | TypeSafe model. |
| `routing.minConfidence` | number 0.5–1 | `0.7` | Probability an answer needs before it is applied. |
| `routing.snoozeUnclear` | boolean | `false` | Snooze a ticket with no clear owner in which the customer asked for nothing yet (a greeting, a test) until their next message. |
| `routing.accounts` | object: account id → (owner name → owner) | required | Routed accounts and the owners Jev chooses from. Owner names are 1–40 lower-case letters, digits, or `_`; `unclear` is reserved. |
| `routing.accounts.<id>.<name>.assignee` | integer > 0 | required | Chatwoot user id to assign. |
| `routing.accounts.<id>.<name>.covers` | 1–1000 characters | required | What the owner handles: Jev's criterion for choosing them. |
| `routing.topics` | object: label → what it covers | unset | Topic labels (Chatwoot label names, lower case) Jev chooses from; one is added when a ticket has no label other than its kinds (an automation rule's label is kept alone). The separate relay can display them using its `forumTags` configuration. Unset: no topic. |
| `routing.kinds` | object: account id → (kind name → kind) | unset | Kinds of ticket Jev recognizes in routed accounts, added as labels beside the topic, and what is done once when it does ([Routing behavior](#routing-behavior)). Kind names are the account's label names (1–40 lower-case letters, digits, `_`, or `-`); `none` is reserved. Unset: none. |
| `routing.kinds.<id>.<name>.covers` | 1–1000 characters | required | What the kind is: Jev's criterion for recognizing it. |
| `routing.kinds.<id>.<name>.cannedResponse` | short code | unset | The account's Chatwoot canned response sent to the customer once, by the account's agent bot (`CHATWOOT_BOT_TOKENS`); none while it does not exist. |
| `routing.kinds.<id>.<name>.status` | `resolved` or `snoozed` | unset | Set instead of routing the ticket (`snoozed`: until the customer's next message), after the reply of a `cannedResponse`; a new customer message reopens it. |

### Secrets

| Secret | Required | Meaning |
| --- | --- | --- |
| `CHATWOOT_TOKEN` | Yes | Chatwoot agent/admin access token for reading and applying decisions. |
| `CHATWOOT_WEBHOOK_SECRETS` | Yes | JSON object of webhook secrets by routed account id. |
| `TYPESAFE_API_KEY` | Yes | TypeSafe Jev API key. |
| `CHATWOOT_BOT_TOKENS` | For kinds that reply | JSON object of Chatwoot agent bot tokens by account id; default `{}`. |

Required secrets are declared with `bindings.secret()`. Optional bot tokens are declared only in development
so deployment without canned replies does not require one. Do not connect a reply-only agent bot to an inbox.

## Routing behavior

With `routing`, each new ticket of a routed account is routed when it is open, has no assignee, and
has a customer message. The Worker asks Jev multiple-choice questions, who owns the ticket (one
of the account's owners, or `unclear`) and its topic (with `topics`), plus its kind (with `kinds`)
and whether the customer asks for anything yet (with `snoozeUnclear`), using the email subject and
the first three customer messages. Before they leave the Worker, emails, URLs, hex and base58 addresses, long
tokens, phone numbers, IP addresses (and four-part version numbers, which read as one), @handles, and the contact's name (each word of two characters or more) are replaced with
`[REDACTED]`. This is best-effort redaction of common identifiers, not anonymization: other personal
details in the text still reach TypeSafe, so check that its data policy suits you. An owner at
`minConfidence` or above is assigned, and a topic at or above it is added as a label when the ticket
has no label other than its kinds (a ticket has one topic label, so one an automation rule set stays alone). When no owner
is clear, Jev is asked again each time the customer adds a message, until one is or three customer
messages were seen; the ticket then stays for a person. With `snoozeUnclear`, Jev is also asked
whether the customer asks for support, information, or an action yet: a ticket without a clear owner
for which Jev is at least `minConfidence` sure there is no request (a greeting, a test, a name alone)
is snoozed until the customer's next message, which reopens it and
asks Jev again, so it waits for detail instead of escalating; after the third message it stays open.
Any other (a request no owner covers, or Jev unsure) stays open for a person. A ticket the customer
wrote to after the messages Jev was given is not snoozed (a message in the moment between that
check and the snooze waits for the customer's next one; the support queue lists the ticket
meanwhile). Customer messages are looked for among the next 300 messages (notes and activity lines count
too): one beyond them is not seen, and the ticket is then not snoozed but left for a person. A ticket assigned
before its turn (by a person or a Chatwoot automation rule) is left alone, and a routed ticket is
never routed again, even if someone unassigns it. The decision is recorded, without expiry, before
it is applied, so a retry applies the same one without asking Jev again. It is applied to the ticket
as it is after Jev answered: an assignee or topic label someone set meanwhile is kept. Routing acts
with `CHATWOOT_TOKEN`, whose user must be an agent in the routed inboxes; Chatwoot records the
assignment as made by that user. The sweep queues routing for open, unassigned tickets in its
window, so a missed webhook only delays it.

With `kinds`, Jev is also asked which of the account's kinds the ticket is (or `none`). Kinds are
labels of a second family: a ticket has one topic label, the category, and a kind Jev is confident
about is added beside it (create each kind as a label in its account; it needs no forum tag, and
the card shows it). It also acts with the decision: a kind with a `status` (spam, for example) sets the
ticket aside, resolved or snoozed until the customer's next message, instead of routing it; the
contact is not blocked, so a new message reopens the ticket as usual. A kind with a `cannedResponse` sends that
Chatwoot canned response (Settings → Canned Responses, by its short code) to the customer, for
example to acknowledge an application or point a security report to its process; a kind with both
replies, then sets the ticket aside (a templated security report: acknowledged, then resolved). It is read when
it is sent, so it is edited in Chatwoot, can use Chatwoot's variables such as `{{contact.name}}`,
and nothing is sent while it does not exist. It is sent as the account's
Chatwoot agent bot (`CHATWOOT_BOT_TOKENS`): customers see the bot's name, such as "Acme Support"; a
bot's message assigns nobody and is no human first reply, and Chatwoot then counts the customer as
answered (no longer waiting) until they write again. Create the bot in the account (Settings →
Bots), without connecting it to an inbox. A reply goes out at most once per ticket: it is recorded
before it is sent, so a failed send is not retried. Once a kind replied or set the ticket aside, the
customer messages it handled (those Jev was given) are relayed without calling the triage bot, with a
note, through the coordination attributes below. The relay waits up to its configured deadline;
if routing is unavailable or slower than that, the message proceeds with its usual mention. Rules that need no judgement of the text (by inbox, sender, or
subject) are Chatwoot's automation rules.

```jsonc
"routing": {
  "accounts": {
    "1": {
      "cloud": { "assignee": 6, "covers": "Cloud support and billing: deployments, invoices, account access." },
      "sales": { "assignee": 7, "covers": "Sales and partnerships: pricing, capacity, volume deals." }
    }
  },
  "topics": { "technical-support": "Something does not work.", "billing": "Payments, invoices, refunds." },
  "kinds": {
    "1": {
      "spam": { "covers": "Unsolicited promotion or scams.", "status": "resolved" },
      "startup-program": { "covers": "A Startup Program application.", "cannedResponse": "startup-program" }
    }
  }
}
```


## Reliability and cutover

The Worker acknowledges after a SQLite job is queued. Alarms serialize decisions, preserve work across failures,
and retry with exponential backoff capped at 30 minutes. The subrequest budget yields to a fresh invocation.
A sweep every five minutes pages open conversations newest activity first, queues completion checks inside its
lookback window (including assigned and pre-cutover tickets), and persists its page cursor. Sweep jobs block
route jobs until all pages finish, including across budget yields and failed-page backoff, so the router cannot
close page-one tickets and shift the remaining pages. A failed pass resumes rather than skipping its remaining
pages. This can delay webhook work too; the relay's wait remains bounded. Other Chatwoot actors can still change
the list during a pass; subsequent overlapping sweeps reconcile that external churn.
Old completed decisions and reply-once markers remain in the Router's own Durable Object.

When splitting an existing relay deployment, **deploy the new relay first**, removing its old `routing` setting and
routing secrets and adding `router.accounts`. Keep its existing Worker `name` and `Hub` export to preserve state.
Then find the newest Chatwoot conversation display id **in each routed account** at cutover and record the map in
`startAfterConversationId`, for example `{ "1": 1200, "2": 85 }`. Deploy the router with the old routing configuration and its secrets, then add its
Chatwoot webhook. Do not start the router while the old embedded routing is active. The cutover watermark
intentionally leaves pre-cutover conversations to humans; old relay routing decisions are not imported. New
customer messages on those tickets are still acknowledged with `routing_seen`. Set the relay's `router.keepLabels`
(for example `["spam", "security", "beg-bounty"]`) to keep legacy kind labels even without `routing_kind`.

Chatwoot conversation display ids are account-local: never use one account's id as another account's cutoff.
The map accepts only accounts in `routing.accounts`, with non-negative integer ids. An omitted account defaults
to `0`, so include every account whose pre-cutover history must be left alone. In the example, account 1 starts
at conversation 1201 and account 2 at 86, independently of the other account's counter.

Redaction is best effort, not anonymization: other personal information can still reach TypeSafe. Review its
policy before enabling routing. Logs contain ids and outcomes, never message bodies or credentials.
See [SECURITY.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/SECURITY.md) to report vulnerabilities,
[CONTRIBUTING.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/CONTRIBUTING.md) for development,
and [CHANGELOG.md](CHANGELOG.md) for releases. Licensed under [MIT](LICENSE).
