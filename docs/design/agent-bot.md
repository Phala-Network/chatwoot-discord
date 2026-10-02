# Design: chatwoot-router as a Chatwoot agent bot

Status: implementation contract. Principle: follow Chatwoot's agent-bot lifecycle instead of reproducing today's behavior. A routed
conversation is the bot's while it is `pending` and the people's otherwise; Chatwoot's status is the only coordination
signal between the router and the relay.

## Chatwoot facts (v4.18.0)

- An inbox with an active agent bot creates conversations as `pending` (blocked contacts are resolved, campaigns
  differ). In such an inbox a resolved conversation reopens as `pending` on a customer message; a snoozed one reopens
  as `open` (`conversation.rb` 307–325, `message.rb` 404–435).
- Ending the bot's turn: the bot's `toggle_status` to `open` on a `pending` conversation runs `bot_handoff!`
  (`conversations_controller.rb` 82–99, `conversation.rb` 183–191); assigning a person to a `pending` conversation that
  the bot holds opens it and clears the bot (`assignment_service.rb` 16–35); the bot may also set `resolved` or
  `snoozed` directly. Handing back to the bot: an assignment to the agent bot sets `pending` and clears the person
  (`assignment_service.rb` 37–46).
- A changed status writes an activity with `content_attributes.activity.type = conversation_status_changed` only
  when `ActivityMessageHandler` has activity content: person/bot changes, automation rules and auto-resolution do;
  customer reopen and scheduled reopen normally do not. The activity job creates the message asynchronously,
  with its execution time (not the status transition time). A no-op status change writes no activity.
- Bot tokens may call conversation show/create/update/toggle_status/toggle_typing_status/toggle_priority/
  custom_attributes, messages create, assignments create, labels index/create (`access_token_auth_helper.rb` 2–7).
  Reading messages, listing conversations and inboxes, and canned responses need a user token.
- The bot's webhooks are signed with the bot's secret; 3 total attempts (initial plus two retries) on 429/500; a final failure of a message event
  opens a `pending` conversation with an "agent bot error" activity (unless the account keeps pending on bot failure)
  (`trigger.rb` 54–88, `agent_bots/webhook_job.rb`). The agent-bot listener sends message and conversation status and
  update events of every conversation of the bot's inboxes, not `conversation_created` (`agent_bot_listener.rb`).
- One linked bot per inbox; `GET inboxes/{id}/agent_bot` answers `{agent_bot: {…}}` (`inboxes_controller.rb` 87–90).
  `meta.assignee_type` tells a bot assignee (`AgentBot`) from a person (`User`) (`event_data_presenter.rb` 42–48).

## Configuration and API contracts

- `routing.botIds` maps every routed account id to its positive safe-integer agent bot id. Its keys must exactly
  match `routing.accounts`. `CHATWOOT_AGENT_BOT_TOKENS` and `CHATWOOT_AGENT_BOT_SECRETS` are JSON objects with
  the same account keys and nonempty string values. They replace the router's `CHATWOOT_BOT_TOKENS` and
  `CHATWOOT_WEBHOOK_SECRETS`; the relay still uses its own account webhook secrets. Credentials are never logged.
- `CHATWOOT_TOKEN` remains a user access token. That user must see **every** routed inbox (membership or account
  administrator); neither a bot token nor a partial inbox view is sufficient. The operator checks this at cutover.
- The router accepts bot deliveries at `/chatwoot/agent-bot`, verifies the bot secret and payload account, and ACKs
  valid irrelevant events without work. There is no router account-webhook endpoint. The relay retains its webhook.
- For a conversation, read its `inbox_id` and GET that account's `inboxes/{id}/agent_bot`; account/inbox scoping is
  enforced by Chatwoot. Validate only `{agent_bot: {id, account_id}}`, discarding other fields (including credentials).
  An unlinked response (`agent_bot: null` or an empty object) means no bot. A routed inbox must link the configured
  bot id and its `account_id` must match. Account-global/system bots are not router bots. The endpoint exposes no
  active flag: **disconnect** to disable routing; an inactive but linked bot is still within the sweep's scope.
  Sweep discovery uses account inboxes followed by these same scoped association reads.
- Preserve `meta.assignee_type` in the shared API response and relay model. Only `User` (or legacy missing type)
  is a person; `AgentBot` is never a person even if its numeric id equals a linked user's id. Unknown explicit types
  are not treated as users. `/pending` reads the current conversation's inbox association and assigns its account
  bot with `{assignee_id: bot.id, assignee_type: "AgentBot"}`; an unlinked inbox uses the ordinary pending status.
  A foreign-account association is an error, never a handback target.

## Router

- **Scope.** Each routed account's brand bot (configured by id) is the agent bot of the inboxes it routes, with the
  router's webhook URL; the router reads which inboxes those are from Chatwoot (`inboxes/{id}/agent_bot`). It acts only
  on `pending` conversations of those inboxes with no person or different bot as assignee.
- **Triggers.** Bot webhooks and a sweep enqueue the same deduplicated conversation job. Each sweep pass lists the
  account's `pending` conversations (`status=pending`, every page, with a user token that sees every routed inbox) and
  keeps those of the routed inboxes (no time window): a conversation a page shift skips is listed by the next pass.
- **Turn.** The bot's turn begins after the conversation's latest status-change activity (or at its start): a status
  change by a person, the bot, an automation, auto-resolve, or a handback leaves one; a customer reopening a resolved
  conversation does not, so its turn begins after the resolution. The router reads messages newest-first, unfiltered
  (activities included), back to that activity, bounded; an incomplete read ends the turn with the handoff. Its inputs
  are the first three customer messages with text after it, so a reopened conversation is decided on its new messages.
  The activity is written asynchronously: a conversation the router saw leave `pending` without it yet is read again.
- **Decision.** As today: owner, topic, kind, request; memoized by input ids, so a new message entering the window gets
  a new decision.
- **Actions,** each after a fresh read that finds the conversation still `pending`, no person assigned, and no
  person's public reply (outgoing, not private, sender a user) in the turn:
  1. topic and kind labels (added if missing);
  2. the kind's canned reply as the bot, at most once per conversation (recorded before sending);
  3. one action ending the turn: the kind's status (`resolved` or `snoozed`, by the bot); else the owner's
     assignment (Chatwoot opens the conversation); else, with no confident owner, the bot's handoff to `open`.
  A successful assignment ends the turn; nothing follows it. A greeting with no request stays `pending` (no action)
  until a message with a request or three texts; empty or identifier-only input, or a person's public reply in the
  turn, ends it with the handoff.
- **Failure.** Retries through the existing queue; every action is checked against a fresh read, so a retry finishes
  what is left and stops once the conversation is no longer the bot's. After the retry limit, or with a missing canned
  response, it ends the turn with the handoff. If the Worker itself is down, Chatwoot's own fallback opens the
  conversation.
- **Removed:** the `routing_seen`, `routing_handled`, `routing_kind` attributes and their definitions, the checkpoint,
  the effects ledger except the reply record, `startAfterConversationId`, the router's account webhook, the sweep
  window.

### Sweep, boundary and recovery

- Reuse the deduplicated queue, alarm subrequest budget and exponential retry delay. A sweep job handles one
  pending-conversation page per run. Persist its next page only after all eligible ids are enqueued; failures retry
  the same page. An empty page completes the pass and resets page to 1 for the next five-minute cron. No time
  cutoff, `startAfterConversationId`, or snapshot assumption. Normal conversation jobs may shift later pages;
  the next full pass picks up skipped pending conversations. Inbox association reads count against the same budget;
  discovery itself continues across alarms, so a large account cannot exhaust every invocation before page 1.
- The boundary reader reads unfiltered latest messages (20 per page), reverses each page, and follows `before`
  using its minimum id. At most five pages (100 messages) per read. The latest undeleted status activity is the
  boundary, including its id and creation time; select customer texts strictly after it, oldest first, at most three.
  Exhausting history without a boundary means the conversation's start only when no previously observed boundary
  or expected transition contradicts that. An incomplete scan hands off without a Jev call.
- The queue retains a small boundary guard (last observed boundary, processing failure count and any expected status activity) needed to
  prevent a stale handoff from acting on a later turn; this is not a history or an effects ledger. Status webhooks
  supply transition status/time; observing the conversation leave pending also requires the next activity. Re-read
  a missing expected activity on the normal failure schedule: three processing attempts, initially, +5s, +10s.
  Then persist handoff mode and open the still-pending conversation. A deleted known boundary, or a deleted activity
  encountered before the boundary, likewise hands off instead of treating old messages as a new turn.
- An activity created late can sort after a new customer message. Without a trustworthy transition hint that
  preserves the ordering, do not classify older text across that boundary; hand off empty input. Chatwoot exposes
  neither a turn API nor `status_changed_at` here: an unseen transition whose activity was permanently removed and
  whose webhook was lost cannot be reconstructed. No invented timestamp or custom attribute claims otherwise.
- Keep the existing decision memo by input ids. Of action effects, keep only `reply:account:conversation`, including
  existing records from 0.1.0. Write it **before** attempting the canned reply; timeout/unknown outcome is never
  resent, even in a later turn. Labels are a fresh union, with existing human topic labels protected. Re-read scope,
  status, assignee, boundary, inputs and human public replies before each action. Chatwoot has no conditional-write
  transaction across these reads and mutations; a change racing the final request cannot be made atomic here.
- Three processing failures select durable handoff mode; a missing canned response selects it immediately. Persist
  handoff before calling explicit bot `status=open`; subsequent retries only revalidate scope/turn and hand off.
  Handoff failures keep the job with exponential backoff capped at 30 minutes, never silently drop it. A new observed
  boundary discards an old turn's handoff. Gone conversations or a disconnected inbox end the job. Non-pending means
  people/Chatwoot own it, not proof that a particular handoff report was emitted. Permission/outage failures cannot
  guarantee a successful handoff until the service is repaired. Worker 2xx followed by an alarm failure uses this
  mechanism; Chatwoot's webhook fallback cannot handle it.
- Request detection is always enabled (remove `snoozeUnclear`). A confident kind action takes precedence; otherwise
  a confident no-request with fewer than three texts stays pending before considering owner/handoff. Blocked contacts
  are untouched; empty, deleted, automatic-email or identifier-only inputs never go to Jev. Preserve sanitization,
  confidence checks, retry budgets and label protection. A public human reply in the current turn forces handoff.
- After assigning a person, return immediately. On a reopened resolved conversation with no bot assignee, Chatwoot's
  assignment service does not open pending. In that case prefer the bot's ordinary handoff, leaving human assignment
  to Chatwoot/people, rather than pretending assignment alone ends the turn or adding another lifecycle protocol.

## Relay

- **Assignee.** `assignee_type` is kept: a bot assignee is no person (no ping, no assignee tag, "Unassigned" in the queue
  and the card). Native error fallback may leave `open` plus a bot assignee; this is shown as unassigned,
  eligible for normal open triage/queue handling. The pending-only router does not repair open conversations.
- **Posting and triage.** A customer message of a `pending` conversation in a bot inbox waits (the job is deferred, as
  today while routing is queued) until a fresh read finds it out of `pending`; then it is posted, with the triage
  mention if the conversation is `open` and no answering reply follows the message: a public outgoing message, not
  private, not failed, not a template (greeting, out-of-office) or an automatic email reply. Triage stays decided once
  per message, and history stays silent. A conversation the bot resolves or snoozes is
  posted without it. Every later message as today. No timer: a Worker that is down is covered by Chatwoot's fallback,
  a failing router by its handoff. Keep one suspended conversation job, not a job/timer per message. A status webhook
  wakes it; every relay sweep also wakes all suspended jobs, even beyond its ordinary lookback. To cover a status
  webhook arriving during suspension, preserve job versions and permit one 1-second re-read; then suspend without
  an alarm until another event or sweep. No maximum pending duration or timeout mention. Cursor and per-message
  triage decisions survive deployment and suspension; retries use the same Discord source/reply association.
  Read current conversation state before releasing a pending customer message, and scan subsequent messages for an
  answering reply (bounded pages with continuation under the existing budget). Qualifying replies are outgoing,
  public, undeleted, not failed, not template, not automatic email; any such bot or human reply counts. Private notes,
  activities and greeting/out-of-office templates do not. A later delivery failure keeps the existing failure notice;
  it does not retrospectively call triage. Automatic customer email and historical messages stay silent.
- **Support queue:** `pending` conversations are listed marked 🤖, without pings/escalations, like snoozed ones.
  Keep the optional hourly cadence and existing wait-age calculation; no new 15-minute notification promise.
- **`/pending`** in a bot inbox hands the ticket back to the bot: an assignment with `assignee_type: "AgentBot"` and
  the inbox's agent bot id (a user token may make it; Chatwoot clears the person and sets `pending`); the Manage
  card keeps the labels in `router.keepLabels` (every kind name).
- **Removed:** `router.accounts`, `router.waitSeconds`, the attribute reads.

## Behavior changes (accepted)

- After the turn ends, new customer messages do not re-route (people own the ticket); a snoozed kind's next message
  goes to people.
- A greeting held by the bot appears in Discord when the turn ends.
- A message the canned reply follows counts as answered, also if the bot decided on earlier messages.
- Chatwoot's reports show the bot's turn (handoffs, bot resolutions); an assignment ends the turn without a handoff
  event.

## Migration and rollback

1. Count existing pending conversations and verify user-token visibility of all intended inboxes. Preserve the existing
   Durable Objects and reply records. Back up non-secret configuration; prepare per-account bots and their credentials.
2. Deploy the relay first (bot inboxes, pending holding, assignee type, native `/pending` handback); remove
   `router.accounts` and `router.waitSeconds`, keep every kind name in `router.keepLabels`. Stop the old router's
   account webhook and cron before replacing it. There must never be old and new router code running in parallel.
   In the relay-first transition, existing open tickets may go directly to triage; pause intake if this is unacceptable.
3. Replace the router in place, retaining its Durable Object namespace/reply records. Its migration drops obsolete
   route/sweep jobs, checkpoints, decision memos and non-reply effects once; the next sweep reconstructs work from
   pending state. Configure `routing.botIds` and both new secrets. Remove the old secret bindings and account webhook
   endpoint; do not create/delete Chatwoot custom attribute definitions in the Worker.
4. Set each brand bot's webhook to `/chatwoot/agent-bot`, then connect inboxes **one account at a time**, only after
   both Workers are ready. Existing open tickets remain with people; existing pending tickets become bot work.
   Retain old `routing_*` values and definitions through the owner's rollback window; remove them manually afterward.
5. Roll back by **disconnecting the bot from every affected inbox first**. Stop the new router and its cron, then
   restore the old router/relay configuration and code if needed, including the old account webhook. Do not run both
   routers. Restore the old sweep settings/cutover ids deliberately; retained attributes and reply records prevent
   blind replay, but accepted lifecycle changes cannot be undone. Relay sweep wakes suspended jobs after disconnect;
   ordinary pending tickets can be opened by people. No pending-message timers require cleanup.

Source contracts above were checked against the v4.18.0 raw sources: `app/models/conversation.rb`,
`app/models/message.rb`, `app/models/concerns/activity_message_handler.rb`,
`app/jobs/conversations/activity_message_job.rb`, `app/services/conversations/assignment_service.rb`,
`app/controllers/api/v1/accounts/conversations_controller.rb`,
`app/controllers/api/v1/accounts/conversations/assignments_controller.rb`,
`app/controllers/api/v1/accounts/inboxes_controller.rb`, `app/views/api/v1/accounts/inboxes/agent_bot.json.jbuilder`,
`app/views/api/v1/models/_agent_bot.json.jbuilder`, `app/presenters/conversations/event_data_presenter.rb`,
`app/finders/message_finder.rb`, `app/finders/conversation_finder.rb`, `app/services/conversations/sort_service.rb`,
`app/controllers/concerns/access_token_auth_helper.rb`, `app/listeners/agent_bot_listener.rb`,
`app/jobs/agent_bots/webhook_job.rb`, `app/listeners/base_listener.rb`, `app/policies/inbox_policy.rb`,
`app/controllers/api/v1/accounts/conversations/messages_controller.rb`, `app/views/api/v1/models/_message.json.jbuilder`,
and `lib/webhooks/trigger.rb` under
<https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/>.
