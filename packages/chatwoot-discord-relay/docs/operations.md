# Operations

Installing on a Chatwoot that already has conversations, replacing another relay, recovering
state, and running without Cloudflare. See the [README](../README.md) for the setup itself.

## Installing on an existing Chatwoot

Conversations with activity within `reconcile.lookbackSeconds` get a post from the first sweep;
older ones get a post with their next message. A new post relays the conversation's whole
history; its messages older than `reconcile.lookbackSeconds` notify no one (see
[Pings and notifications](relay.md#pings-and-notifications)).
To start with new messages only, use a verified committed boundary for
`relay.startAfterMessageId`. Replacing an existing relay additionally requires the quiesced cut below.

## Cutover from an existing relay

Follow the [adoption and rollback runbook](adoption.md). Repair and verify all old post links,
prebuild the thread directory, and obtain a quiesced processed watermark and interaction fence.
The owner must authorize the maintenance/cutover operation separately. Switching webhooks or
choosing the newest message from one API page does not prove the old relay drained.

## State and recovery

All state (which post belongs to which conversation, how far each is relayed, the Discord ids
of posted messages, the job queue) is in each Conversation Durable Object's SQLite database. Restore it,
if it is lost or damaged, with Durable Objects'
[point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
(any point in the last 30 days).

Without that, a new database recovers each post from the conversation's link attribute on the
conversation's next run, but not how far it was relayed: with `relay.startAfterMessageId` 0 an
adopted post continues after the conversation's latest message (messages not yet relayed are
skipped), and with a watermark it relays everything after the watermark again (duplicates).
The Discord ids of posted messages are gone, so messages deleted in Chatwoot later stay in
Discord.

## Self-hosting without Cloudflare

Self-hosting without Cloudflare is possible with the open-source
[workerd](https://github.com/cloudflare/workerd) runtime (Durable Objects with SQLite and alarms
are supported); you provide TLS, the cron trigger, and storage persistence.
