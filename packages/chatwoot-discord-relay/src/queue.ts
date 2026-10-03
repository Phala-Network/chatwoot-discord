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
import type { Budget } from "../../../shared/budget.ts";
import { type ChatwootClient, CONVERSATIONS_PER_PAGE, personAssignee } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { log } from "../../../shared/log.ts";
import { relaysInbox, type Settings } from "./config.ts";
import type { DiscordRest } from "./discord/rest.ts";
import { Effects } from "./effects.ts";
import { PENDING_PAGES, QUEUE_MESSAGES, QUEUE_PAGES, SNOOZED_PAGES } from "./queue-limits.ts";
import { clip, conversationUrl, defused } from "./relay/format.ts";
import { threadIdFromUrl } from "./relay/processor.ts";

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
  set(key: string, value: string, ttlMs?: number): void;
  conversation?(accountId: number, conversationId: number): { threadId?: string | undefined } | undefined;
}

export interface QueueContext {
  settings: Settings;
  store: QueueStore;
  chatwoot: ChatwootClient;
  rest: DiscordRest;
  budget?: Budget;
}

const ticketSchema = z.object({
  accountId: z.number(),
  accountName: z.string(),
  conversationId: z.number(),
  waitingSince: z.number(),
  assignee: z.object({ id: z.number(), name: z.string() }).nullable(),
  escalate: z.boolean(),
  snoozed: z.boolean(),
  pending: z.boolean(),
  threadId: z.string().optional(),
});
type Ticket = z.infer<typeof ticketSchema>;
const passSchema = z.object({
  source: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  tickets: z.array(ticketSchema),
  unread: z.boolean(),
  part: z.number().int().min(0),
});

interface Chunk {
  content: string;
  users: Set<string>;
  role: boolean;
}

export const escalationsSchema = z.record(z.string(), z.object({ since: z.number(), level: z.number() }));
type Escalations = z.infer<typeof escalationsSchema>;

/** How many escalation steps (1, 2, 4, 8, 16 h, then every 24 h) a wait has reached. */
function escalationLevel(hours: number): number {
  const last = ESCALATION_HOURS.at(-1) ?? 0;
  if (hours < last) return ESCALATION_HOURS.filter((step) => hours >= step).length;
  return ESCALATION_HOURS.length + Math.floor((hours - last) / ESCALATION_REPEAT_HOURS);
}

/**
 * Posts the queue as of `now`. Nothing is posted after `deadline`: a run past it is dropped,
 * whole or from the message it reached (see QueueDigest).
 */
export async function postQueue(
  ctx: QueueContext,
  now = Date.now(),
  deadline = Number.POSITIVE_INFINITY,
): Promise<"done" | "yield"> {
  const { settings, store, chatwoot, rest, budget } = ctx;
  const queue = settings.config.queue;
  if (!queue || Date.now() > deadline) return "done";
  const nowSeconds = now / 1000;
  const saved = escalationsSchema.safeParse(parseJson(store.get(ESCALATIONS_KEY)));
  const previous = saved.success ? saved.data : {};
  const key = `queue:pass:${now}`;
  const savedPass = passSchema.safeParse(parseJson(store.get(key)));
  const reads = [
    { status: "open", pages: QUEUE_PAGES },
    { status: "snoozed", pages: SNOOZED_PAGES },
    { status: "pending", pages: PENDING_PAGES },
  ] as const;
  const pass = savedPass.success
    ? savedPass.data
    : {
        source: 0,
        page: 1,
        tickets: [],
        unread: false,
        part: 0,
      };
  const save = () => store.set(key, JSON.stringify(pass), 3 * 60 * 1000);
  const sources = settings.config.accounts.flatMap((account) => reads.map((read) => ({ account, ...read })));
  let read = 0;
  while (pass.source < sources.length) {
    if (Date.now() >= deadline) return "done";
    budget?.checkpoint();
    if (budget && (read >= 1 || budget.remaining < 8)) {
      save();
      return "yield";
    }
    const source = sources[pass.source];
    if (!source) break;
    const { account, status, pages } = source;
    const conversations = await chatwoot.listConversations(account.id, pass.page, status);
    for (const conversation of conversations) {
      const conversationId = conversation.id;
      if (conversationId === undefined || !relaysInbox(account, conversation.inbox_id)) continue;
      const assignee = personAssignee(conversation);
      const waitingSince = conversation.waiting_since ?? 0;
      if (status !== "pending" && assignee && !waitingSince) continue;
      const threadId = threadIdFromUrl(conversation.custom_attributes?.[settings.config.relay.linkAttribute]);
      pass.tickets.push({
        accountId: account.id,
        accountName: account.name,
        conversationId,
        waitingSince,
        assignee: assignee?.id ? { id: assignee.id, name: assignee.name ?? "" } : null,
        escalate: false,
        snoozed: status === "snoozed",
        pending: status === "pending",
        ...(threadId ? { threadId } : {}),
      });
    }
    if (conversations.length < CONVERSATIONS_PER_PAGE || pass.page >= pages) {
      if (pass.page >= pages && conversations.length === CONVERSATIONS_PER_PAGE) pass.unread = true;
      pass.source += 1;
      pass.page = 1;
    } else pass.page += 1;
    read += 1;
    save();
  }
  const tickets = pass.tickets;
  const unread = pass.unread;
  const escalations: Escalations = {};
  for (const ticket of tickets) {
    if (
      ticket.snoozed ||
      ticket.pending ||
      ticket.assignee ||
      !ticket.waitingSince ||
      !(queue.escalationRoleId ?? queue.escalationUserId)
    )
      continue;
    const escalationKey = `${ticket.accountId}:${ticket.conversationId}`;
    const level = escalationLevel((nowSeconds - ticket.waitingSince) / 3600);
    const reached = previous[escalationKey]?.since === ticket.waitingSince ? previous[escalationKey].level : 0;
    if (pass.part === 0) ticket.escalate = level > reached;
    escalations[escalationKey] = { since: ticket.waitingSince, level };
  }
  save();

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
  for (let index = pass.part; index < chunks.length; index += 1) {
    if (late()) return "done";
    budget?.checkpoint();
    if (budget && budget.remaining < 8) return "yield";
    const chunk = chunks[index];
    if (!chunk) break;
    const effect = await new Effects(store).run(
      `digest:${queue.channelId}:${Math.floor(nowSeconds / 3600)}:${index}`,
      { content: chunk.content, users: [...chunk.users], role: chunk.role },
      async (frozen) => {
        const receipt = await post(
          rest,
          queue.channelId,
          { ...frozen, users: new Set(frozen.users) },
          queue.escalationRoleId,
          nonce(index),
        );
        if (!receipt?.id || !/^\d+$/.test(receipt.id)) throw new TypeError("Missing digest receipt");
        return { messageId: receipt.id };
      },
    );
    if (effect.state === "UNKNOWN")
      log.warn("digest part unknown", { part: index, hour: Math.floor(nowSeconds / 3600) });
    if (index === 0) store.set(ESCALATIONS_KEY, JSON.stringify(unread ? { ...previous, ...escalations } : escalations));
    pass.part = index + 1;
    save();
  }
  if (chunks.length === 0)
    store.set(ESCALATIONS_KEY, JSON.stringify(unread ? { ...previous, ...escalations } : escalations));
  log.info("support queue", {
    tickets: tickets.length,
    escalated: tickets.filter((ticket) => ticket.escalate).length,
    messages: chunks.length,
  });
  return "done";
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
  const threadId = ticket.threadId ?? store.conversation?.(ticket.accountId, ticket.conversationId)?.threadId;
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
): Promise<RESTPostAPIChannelMessageResult> {
  return rest.post<RESTPostAPIChannelMessageResult, RESTPostAPIChannelMessageJSONBody>(
    Routes.channelMessages(channelId),
    {
      body: {
        content: chunk.content,
        nonce,
        enforce_nonce: true,
        allowed_mentions: { parse: [], users: [...chunk.users].sort(), roles: chunk.role && roleId ? [roleId] : [] },
      },
      // A rate limit goes back to the job, which waits and checks the queue's deadline first.
    },
  );
}
