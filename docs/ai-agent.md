# Connecting an AI agent

chatwoot-discord does not run an AI model. It gives an AI agent (any Discord bot you operate,
called the *triage bot* in the configuration) a place in the ticket workflow: the agent is called
on customer messages, reads the ticket in its forum post, and proposes a reply that a human sends.
This page is the contract such an agent follows.

![A ticket post: the customer's message ends with the triage bot mention; the bot answers with an analysis and a draft; an agent sends the draft with Apps → Reply with this](assets/ticket.png)

*Illustration with fictional data.*

## Configuration

Set `triage.userId` in `CONFIG` to the agent's Discord user id. Optional settings (see the
[configuration reference](../README.md#configuration-reference)):

| Key | Default | Meaning |
|---|---|---|
| `triage.name` | `Triage bot` | Name used in the notes posted when the budget is used up. |
| `triage.perConversationPerHour` / `perHour` | `5` / `30` | How many customer messages call the agent, per conversation and in total, each hour. |
| `triage.draftLabels` | `["Draft"]` | Labels that introduce the agent's draft. |

The agent's bot needs to see the forum and its posts, read message content there, and send
messages in posts (threads).

## When the agent is called

Each new customer message relayed into a post ends with a line that mentions the agent:

```text
-# <@AGENT_USER_ID>
```

A customer message longer than one Discord message is split into several; the mention is on the
last of them (before a "Message truncated" note, if any), so when the agent sees it, the whole
message is already in the post.

The mention is a literal token in the message content; Discord sends no notification for it
(the relay's `allowed_mentions` leaves it out), so nobody is pinged by it. Only customer
messages carry it. Agent replies, private notes, activity lines, the ticket card that opens a
post, and customers' responses to interactive messages (option picks, forms, CSAT ratings) do
not. Neither do automatic email replies (out of office, for example), nor customer messages
created more than `reconcile.lookbackSeconds` (an hour by default) before they are relayed: the
history posted when an older conversation gets its post, or messages caught up after downtime.

When a conversation has had more than `perConversationPerHour` customer messages in the current
hour, or all conversations together more than `perHour`, the mention is replaced by a note such
as `-# Triage bot not called: more than 30 customer messages this hour. Ask it here if needed.`

The agent must:

1. React only to messages in the forum's posts whose content contains its own mention token.
   These messages are posted by the relay's webhook (named `Chatwoot`) under the customer's
   name, so the agent must not ignore messages from webhooks or bots when they mention it.
2. Ignore everything else in the post unless a human asks it directly.

## What the agent posts

The agent answers in the same post with its analysis and, when it has one, a proposed reply: a
line containing a draft label, followed on the next line by a fenced code block with the reply
text. For example:

````markdown
Likely cause: the invoice was generated before the address change on March 3.

**Draft**:
```
Hi Marcus, thanks for letting us know! The invoice was created before your address change.
I have issued a corrected copy; you will find it under Billing → Invoices.
```
````

- Only the first code block after a draft label counts, so the agent may post other code
  blocks (logs, progress) in the same or other messages.
- Code blocks follow CommonMark: a fence of three or more backticks or tildes, closed by the same
  character, at least as many, on a line of its own. When the draft itself contains a code block,
  fence it with more backticks (`` ```` ``) or with tildes (`~~~`).
- The label may be decorated (`**Draft**:`, `Draft (English):`); any configured label in
  `triage.draftLabels` works.
- Keep the draft under 4,000 characters, the reply editor's limit.

A human agent then uses **Apps → Reply with this** on that message. It opens the `/reply` editor
prefilled with the draft; they can edit it, add attachments, and submit. The reply is sent in
Chatwoot with that human's own access token, so it appears under their name, Chatwoot's
permissions apply, and an unassigned conversation is assigned to them.

## What the agent must not do

- Never send anything to the customer itself. Text posted in a Discord post never reaches the
  customer; only the commands do, and they run as the linked human who uses them. Do not let the
  agent send messages through Chatwoot's API either.
- Do not change the post's tags or archived state; the relay sets them from Chatwoot and replaces
  them the next time the conversation's status, assignee, or topic changes.

## Optional: read-only context from Chatwoot

The post is enough for most tickets, but an agent may read more (earlier conversations, contact
details) from Chatwoot's API. Chatwoot access tokens are not scoped: any agent's token can also
send messages. Give the AI agent its own Chatwoot user, a member of only the inboxes it needs, and
let it make read (`GET`) requests only.

- The ticket card that opens every post links to the conversation:
  `https://<chatwoot>/app/accounts/<account id>/conversations/<conversation id>`. The post title
  starts with `[<Account> #<conversation id>]`.
- In the other direction, each conversation's `discord_thread` custom attribute (the
  `relay.linkAttribute` setting) holds the post URL, `https://discord.com/channels/<guild id>/<post id>`,
  so a job that reads Chatwoot (for example a digest of conversations waiting for a reply) can
  link to the posts.
