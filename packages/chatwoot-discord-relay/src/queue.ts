// The support queue: every hour (the cron run at minute 0), a message in `queue.channelId` lists
// the open tickets that wait for a reply or have no assignee, longest wait first, and pings their
// linked assignees. An unassigned ticket whose customer has waited 1, 2, 4, 8, and 16 hours, and
// every 24 hours after that, also pings `queue.escalationRoleId` (or `escalationUserId`), once per
// step, until someone takes it or replies (a new customer message after a reply starts over).
// Snoozed tickets that match are listed last, marked 💤, and ping no one. Nothing is posted when the
// queue is empty.
//
// A line shows only the ticket's post (or dashboard link), its wait, and its assignee: no customer
// text. Mentions are allowed from the tickets' fields (linked assignees, the escalation), never
// from the message text.

import {
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPIChannelMessageResult,
  Routes,
} from "discord-api-types/v10";
import { z } from "zod";
import { type ChatwootClient, CONVERSATIONS_PER_PAGE, personAssignee } from "../../../shared/chatwoot/api.ts";
import { log } from "../../../shared/log.ts";
import { relaysInbox, type Settings } from "./config.ts";
import type { DiscordRest } from "./discord/rest.ts";
import { PENDING_PAGES, QUEUE_MESSAGES, QUEUE_PAGES, SNOOZED_PAGES } from "./queue-limits.ts";
import { clip, conversationUrl, defused } from "./relay/format.ts";

const ESCALATION_HOURS = [1, 2, 4, 8, 16];
const ESCALATION_REPEAT_HOURS = 24;
const CONTENT_LIMIT = 2000;
/** Room kept in the last message for the note on tickets not listed. */
const NOTE_ROOM = 40;
/** Longest assignee name shown (an unlinked agent's Chatwoot name). */
const NAME_LIMIT = 60;
/** Per unassigned waiting ticket ("<account>:<conversation>"): the wait it was escalated for, and how far. */
const ESCALATIONS_KEY = "queue:escalations";

export interface QueueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  conversation(accountId: number, conversationId: number): { threadId?: string | undefined } | undefined;
}

export interface QueueContext {
  settings: Settings;
  store: QueueStore;
  chatwoot: ChatwootClient;
  rest: DiscordRest;
}

interface Ticket {
  accountId: number;
  accountName: string;
  conversationId: number;
  /** Unix seconds since the customer has waited for a reply; 0 when they do not. */
  waitingSince: number;
  assignee: { id: number; name: string } | null;
  escalate: boolean;
  snoozed: boolean;
  pending: boolean;
}

interface Chunk {
  content: string;
  users: Set<string>;
  role: boolean;
}

const escalationsSchema = z.record(z.string(), z.object({ since: z.number(), level: z.number() }));
type Escalations = z.infer<typeof escalationsSchema>;

/** How many escalation steps (1, 2, 4, 8, 16 h, then every 24 h) a wait has reached. */
export function escalationLevel(hours: number): number {
  const last = ESCALATION_HOURS.at(-1) ?? 0;
  if (hours < last) return ESCALATION_HOURS.filter((step) => hours >= step).length;
  return ESCALATION_HOURS.length + Math.floor((hours - last) / ESCALATION_REPEAT_HOURS);
}

/**
 * Posts the queue as of `now`. Nothing is posted after `deadline`: a run past it is dropped,
 * whole or from the message it reached (see Hub).
 */
export async function postQueue(
  ctx: QueueContext,
  now = Date.now(),
  deadline = Number.POSITIVE_INFINITY,
): Promise<void> {
  const { settings, store, chatwoot, rest } = ctx;
  const queue = settings.config.queue;
  if (!queue) return;
  const nowSeconds = now / 1000;
  const previous = readEscalations(store.get(ESCALATIONS_KEY));
  const escalations: Escalations = {};
  const tickets: Ticket[] = [];
  let unread = false;

  const reads = [
    { status: "open", pages: QUEUE_PAGES },
    { status: "snoozed", pages: SNOOZED_PAGES },
    { status: "pending", pages: PENDING_PAGES },
  ] as const;
  for (const account of settings.config.accounts) {
    for (const { status, pages } of reads) {
      for (let page = 1; page <= pages; page += 1) {
        const conversations = await chatwoot.listConversations(account.id, page, status);
        for (const conversation of conversations) {
          const conversationId = conversation.id;
          if (conversationId === undefined || !relaysInbox(account, conversation.inbox_id)) continue;
          const assignee = personAssignee(conversation);
          const waitingSince = conversation.waiting_since ?? 0;
          if (status !== "pending" && assignee && !waitingSince) continue;
          const snoozed = status === "snoozed";
          let escalate = false;
          if (status === "open" && !assignee && waitingSince && (queue.escalationRoleId ?? queue.escalationUserId)) {
            const key = `${account.id}:${conversationId}`;
            const level = escalationLevel((nowSeconds - waitingSince) / 3600);
            const reached = previous[key]?.since === waitingSince ? previous[key].level : 0;
            escalate = level > reached;
            escalations[key] = { since: waitingSince, level };
          }
          tickets.push({
            accountId: account.id,
            accountName: account.name,
            conversationId,
            waitingSince,
            assignee: assignee?.id ? { id: assignee.id, name: assignee.name ?? "" } : null,
            escalate,
            snoozed,
            pending: status === "pending",
          });
        }
        if (conversations.length < CONVERSATIONS_PER_PAGE) break;
        if (page === pages) unread = true;
      }
    }
  }

  const wait = (ticket: Ticket) => ticket.waitingSince || Number.POSITIVE_INFINITY;
  tickets.sort((a, b) => Number(a.snoozed || a.pending) - Number(b.snoozed || b.pending) || wait(a) - wait(b));
  const chunks = tickets.length > 0 ? messages(ctx, tickets, nowSeconds, unread) : [];
  // A nonce per hour and part: Discord creates no second message for a retried request it took.
  const nonce = (index: number) => `queue-${Math.floor(nowSeconds / 3600)}-${index}`;
  const late = () => {
    const over = Date.now() > deadline;
    if (over) log.warn("support queue past its deadline; not posted", { messages: chunks.length });
    return over;
  };
  const [first, ...more] = chunks;
  if (first) {
    if (late()) return;
    await post(rest, queue.channelId, first, queue.escalationRoleId, nonce(0));
  }
  // The first message carries any escalation ping: record it at once, so a later part that fails
  // does not ping again when the job is retried. Tickets beyond the pages read keep their record
  // until a complete run no longer sees them.
  store.set(ESCALATIONS_KEY, JSON.stringify(unread ? { ...previous, ...escalations } : escalations));
  for (const [index, chunk] of more.entries()) {
    if (late()) return;
    await post(rest, queue.channelId, chunk, queue.escalationRoleId, nonce(index + 1));
  }
  log.info("support queue", {
    tickets: tickets.length,
    escalated: tickets.filter((ticket) => ticket.escalate).length,
    messages: chunks.length,
  });
}

function messages(ctx: QueueContext, tickets: Ticket[], nowSeconds: number, unread: boolean): Chunk[] {
  const { escalationRoleId: roleId, escalationUserId: userId } = ctx.settings.config.queue ?? {};
  const escalate = tickets.some((ticket) => ticket.escalate);
  let header = `📋 Support queue <t:${Math.floor(nowSeconds)}:t>`;
  if (escalate) {
    const mention = roleId ? `<@&${roleId}>` : `<@${userId}>`;
    header += `\n${mention} 🔔 tickets have waited with no assignee: please \`/assign\` one.`;
  }
  const users = new Set(escalate && userId ? [userId] : []);
  const chunks: Chunk[] = [{ content: header, users, role: escalate && roleId !== undefined }];
  let shown = 0;
  for (const ticket of tickets) {
    const text = line(ctx, ticket, nowSeconds);
    const last = chunks.at(-1);
    if (!last) break;
    const limit = chunks.length === QUEUE_MESSAGES ? CONTENT_LIMIT - NOTE_ROOM : CONTENT_LIMIT;
    if (last.content.length + 1 + text.length <= limit) {
      last.content += `\n${text}`;
    } else if (chunks.length < QUEUE_MESSAGES) {
      chunks.push({ content: text, users: new Set(), role: false });
    } else {
      break;
    }
    const linked = ticket.snoozed || ticket.pending ? undefined : ctx.settings.linkedAgent(ticket.assignee?.id);
    if (linked) chunks.at(-1)?.users.add(linked.discordUserId);
    shown += 1;
  }
  const hidden = tickets.length - shown;
  const last = chunks.at(-1);
  if (last && (hidden > 0 || unread)) {
    const note = `…and ${hidden > 0 ? `${hidden} more` : "more"}: see Chatwoot.`;
    // The last allowed message kept NOTE_ROOM for it; an earlier one may be full.
    if (last.content.length + 1 + note.length <= CONTENT_LIMIT) last.content += `\n${note}`;
    else chunks.push({ content: note, users: new Set(), role: false });
  }
  return chunks;
}

function line(ctx: QueueContext, ticket: Ticket, nowSeconds: number): string {
  const { settings, store } = ctx;
  const threadId = store.conversation(ticket.accountId, ticket.conversationId)?.threadId;
  const url = conversationUrl(settings.frontendUrl, ticket.accountId, ticket.conversationId);
  const post = threadId ? `<#${threadId}>` : `[${ticket.accountName} #${ticket.conversationId}](<${url}>)`;
  const waiting = ticket.waitingSince ? `waiting ${duration(nowSeconds - ticket.waitingSince)}` : "replied";
  const linked = ticket.snoozed || ticket.pending ? undefined : settings.linkedAgent(ticket.assignee?.id);
  const owner = linked
    ? `<@${linked.discordUserId}>`
    : ticket.assignee
      ? defused(clip(ticket.assignee.name, NAME_LIMIT))
      : "❔ Unassigned";
  const mark = ticket.escalate ? "🔔 " : ticket.snoozed ? "💤 " : ticket.pending ? "🤖 " : "";
  return `${mark}${post} | ${waiting} | ${owner}`;
}

function duration(seconds: number): string {
  const minutes = Math.max(Math.floor(seconds / 60), 0);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}

async function post(
  rest: DiscordRest,
  channelId: string,
  chunk: Chunk,
  roleId: string | undefined,
  nonce: string,
): Promise<void> {
  await rest.post<RESTPostAPIChannelMessageResult, RESTPostAPIChannelMessageJSONBody>(
    Routes.channelMessages(channelId),
    {
      body: {
        content: chunk.content,
        nonce,
        enforce_nonce: true,
        allowed_mentions: { parse: [], users: [...chunk.users].sort(), roles: chunk.role && roleId ? [roleId] : [] },
      },
      // A rate limit goes back to the job, which waits and checks the queue's deadline first.
      retry: false,
    },
  );
}

function readEscalations(stored: string | undefined): Escalations {
  if (stored === undefined) return {};
  try {
    const parsed = escalationsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
