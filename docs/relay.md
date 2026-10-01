# How conversations are relayed

What the relay posts in a ticket's forum post, and how it handles the less common cases. See the
[README](../README.md) for an overview, and [Internals](internals.md) for how it is built.

## Posts and messages

- Every conversation of a configured account is relayed, or only those of the inboxes in
  `accounts[].inboxIds` when it is set. Messages from blocked contacts are not relayed.
- Each conversation gets one forum post, titled `[<Account> #<id>] <customer> — <subject or first
  message>`. It opens with a ticket header (channel, inbox, customer email, phone number on phone
  channels, "Open in Chatwoot" link), and every message follows it. Bots act on a post's replies
  but not on its opening message, so the header lets the first customer message reach a triage
  bot like any other.
- Messages are posted through the forum webhook, so each shows its sender's name and avatar:
  customers (their https Chatwoot avatar, else `avatars.contact`), agents as `Name · Account`, agent
  bots by their name and https Chatwoot avatar (else `avatars.chatwoot`), and
  everything else as `Chatwoot` (`avatars.chatwoot`). Templates (greetings, CSAT) and messages
  with nothing to show are skipped.
- An agent's replies and notes show the Discord avatar of the agent's linked Discord user
  (`agents[]`), else the agent's https Chatwoot avatar, else `avatars.chatwoot`. The bot looks
  each linked agent up at most once a day (one extra Discord request); if that fails, it uses the
  fallback and tries again an hour later.
- The post title follows the contact's name when it changes (on the conversation's next sync);
  posts adopted from another relay or created by earlier versions keep their title.

## Tags and archiving

Tags are the forum's `forumTags` for what the conversation has; anything without a tag there is
skipped. Discord applies at most 5 per post, taken in this order: account, status, assignee
(by Chatwoot user id, so a renamed agent keeps their tag), topic (the conversation's
`relay.topicAttribute` custom attribute), priority, then labels. A resolved conversation's post
is archived; any other status unarchives it. When Discord refuses a request because a tag was
deleted in Discord, it is sent again without the missing tags, and a warning names them.

## Pings and notifications

- A newly assigned agent who is linked in `agents[]` is pinged once (a change of their Chatwoot
  name does not count as a new assignment), in a `-# Assigned to @name` notice after the live
  messages that came with the assignment (after the last one, when the conversation was
  reassigned several times in a row), and is added to the post, so it shows in their thread list
  (if Discord refuses, e.g. they left the server, only a warning is logged). After that, every
  customer message pings the linked assignee, on the same line as the triage mention. A linked
  agent @mentioned in a private note is pinged there; other Chatwoot mentions show as `@name`.
  Nothing else pings anyone.
- Notification lines (the triage mention, pings, budget notes) go on the last Discord message of
  a split message, so a bot they call sees all of it. Only live messages carry them: messages
  created more than `reconcile.lookbackSeconds` ago (the history of an older conversation, or a
  catch-up after downtime) are posted without them.

## Message content

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

## Changes after posting

- A message deleted in Chatwoot is deleted from the post once Chatwoot's API confirms it, with
  the response and notice posted about it; when the post's title quotes it, the title keeps only
  the ticket and the customer. This uses the forum webhook that posted them; if that webhook was
  deleted in Discord (the relay then creates a new one), its messages stay, because the bot has no
  permission to delete others' messages.
- A customer's response to an interactive message (option pick, form, CSAT rating, email
  request) is posted under the customer's name, formatted like Chatwoot's Slack integration. A
  changed response is posted again; an unchanged one is not. A response (or a delivery failure)
  that exists when its message is first relayed is posted with it.
- A reply the channel could not deliver (Chatwoot marks it failed, e.g. outside WhatsApp's
  24-hour window) gets one ⚠️ notice in the post with the channel's reason.
- A conversation deleted in Chatwoot gets a notice in its post, which is archived and forgotten.
  Chatwoot sends no webhook for a deletion (v4.18.0), so this happens when the next event for it
  arrives or a command in the post finds it gone.

## Failures

A post deleted in Discord is recreated on the next message. A message Discord refuses as
invalid (an HTTP 4xx other than 401, 403, 404, 408, and 429) is skipped with a ⚠️ notice in its
post after `relay.maxAttempts` (5) attempts. Rate limits, Discord server errors, timeouts, and
missing permissions never skip a message: its job retries until Discord accepts it, and waits
as long as Discord asks when rate limited.
