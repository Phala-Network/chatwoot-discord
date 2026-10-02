# Design: chatwoot-router as a Chatwoot agent bot

Status: proposal. Principle: follow Chatwoot's agent-bot lifecycle instead of reproducing today's behavior. A routed
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
- Every status change made by a person, a bot, an automation, or auto-resolve leaves an activity message with
  `content_attributes.activity.type = conversation_status_changed` (`activity_message_handler.rb`); a customer's
  message reopening a resolved conversation leaves none.
- Bot tokens may call conversation show/create/update/toggle_status/toggle_typing_status/toggle_priority/
  custom_attributes, messages create, assignments create, labels index/create (`access_token_auth_helper.rb` 2–7).
  Reading messages, listing conversations and inboxes, and canned responses need a user token.
- The bot's webhooks are signed with the bot's secret; up to 3 attempts on 429/500; a final failure of a message event
  opens a `pending` conversation with an "agent bot error" activity (unless the account keeps pending on bot failure)
  (`trigger.rb` 54–88, `agent_bots/webhook_job.rb`). The agent-bot listener sends message and conversation status and
  update events of every conversation of the bot's inboxes, not `conversation_created` (`agent_bot_listener.rb`).
- One bot per inbox; `GET inboxes/{id}/agent_bot` answers `{agent_bot: {…}}` (`inboxes_controller.rb` 87–90).
  `meta.assignee_type` tells a bot assignee (`AgentBot`) from a person (`User`) (`event_data_presenter.rb` 42–48).

## Router

- **Scope.** Each routed account's brand bot (configured by id) is the agent bot of the inboxes it routes, with the
  router's webhook URL; the router reads which inboxes those are from Chatwoot (`inboxes/{id}/agent_bot`). It acts only
  on `pending` conversations of those inboxes with no person as assignee.
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

## Relay

- **Assignee.** `assignee_type` is kept: a bot assignee is no person (no ping, no assignee tag, "Unassigned" in the queue
  and the card).
- **Posting and triage.** A customer message of a `pending` conversation in a bot inbox waits (the job is deferred, as
  today while routing is queued) until a fresh read finds it out of `pending`; then it is posted, with the triage
  mention if the conversation is `open` and no answering reply follows the message: a public outgoing message, not
  private, not failed, not a template (greeting, out-of-office) or an automatic email reply. Triage stays decided once
  per message, and history stays silent. A conversation the bot resolves or snoozes is
  posted without it. Every later message as today. No timer: a Worker that is down is covered by Chatwoot's fallback,
  a failing router by its handoff.
- **Support queue:** `pending` conversations are listed marked 🤖, without pings, like snoozed ones.
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

## Migration

1. Deploy the relay (bot inboxes, `pending`, `assignee_type`, `/pending` handback).
2. Deploy the router with each account's bot id, bot token, and bot secret.
3. In Chatwoot, set each brand bot's webhook URL and connect it to the routed inboxes, one account first. Existing
   `open` conversations are untouched; existing `pending` ones (count them first) are routed.
4. Retire the relay-era attributes and the router's old account webhook after the rollback window.
