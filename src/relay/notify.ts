// Who a relayed message notifies, as lines added to its last part: the triage bot mention
// (within its hourly budgets) and the linked assignee's ping on customer messages. Also who a
// post announces as newly assigned, which Relay posts after the live messages of a run. Only
// live messages notify; history relayed later (the first sync of an older conversation, a
// catch-up after downtime) and automatic email replies are posted without them.

import { fromCustomer } from "./format.ts";
import type { RelayStore } from "./relay.ts";
import type { LinkedAgent, RelayConversation, RelayMessage } from "./types.ts";

export interface TriageOptions {
  userId: string;
  name: string;
  perConversationPerHour: number;
  perHour: number;
}

interface NotifierOptions {
  store: RelayStore;
  triage?: TriageOptions | undefined;
  /** The agent linked to a Chatwoot user id, if any. */
  linkedAgent?: ((chatwootUserId: number) => LinkedAgent | undefined) | undefined;
  /** A message created longer ago than this is history. */
  liveSeconds: number;
  now: () => Date;
}

interface Notification {
  lines: string[];
  /** Users the lines may ping. */
  users: string[];
}

/** Who a post announces as its assignee: their Chatwoot user id, which a rename does not change; "" for none. */
export function assigneeKey(conversation: RelayConversation): string {
  const assigneeId = conversation.assignee?.id;
  return assigneeId ? String(assigneeId) : "";
}

/** The longest user mention (snowflakes have at most 20 digits). */
const LONGEST_MENTION = `<@${"9".repeat(20)}>`;

export class Notifier {
  /** The most room the notification lines of a message can take, in UTF-16 units. */
  readonly reserve: number;

  constructor(private readonly options: NotifierOptions) {
    const { triage } = options;
    const lines = [
      `-# ${LONGEST_MENTION} ${LONGEST_MENTION}`,
      ...(triage ? [conversationBudgetNote(triage), hourlyBudgetNote(triage)] : []),
    ];
    this.reserve = lines.reduce((sum, line) => sum + line.length + 1, 0);
  }

  /** The notification lines for a message; the same on every attempt at posting it. */
  notification(message: RelayMessage): Notification {
    if (!this.notifies(message)) return { lines: [], users: [] };
    // While a new assignee waits for their announcement, which pings them, do not ping twice.
    const ping = fromCustomer(message) && !this.newAssignee(message.account.id, message.conversation);
    const assignee = ping ? this.linkedAssignee(message.conversation) : undefined;
    const triage = this.triage(message);
    const mentions = [triage.mention, assignee].filter((id) => id !== undefined).map((id) => `<@${id}>`);
    const lines = [mentions.length > 0 ? `-# ${mentions.join(" ")}` : undefined, triage.note].filter(
      (line) => line !== undefined,
    );
    // The triage mention stays a literal token: only the assignee may be pinged.
    return { lines, users: assignee ? [assignee] : [] };
  }

  /**
   * Whether a message notifies: it is live (created within `liveSeconds`) and not an automatic
   * email reply.
   */
  notifies(message: RelayMessage): boolean {
    if (message.autoReply) return false;
    if (message.createdAt === undefined || message.createdAt === null) return true;
    return this.options.now().getTime() - message.createdAt * 1000 <= this.options.liveSeconds * 1000;
  }

  /**
   * When the conversation's assignee is not the one its post last announced, and is linked, their
   * Discord id: the announcement pings them (which also adds them to the post).
   */
  newAssignee(accountId: number, conversation: RelayConversation): string | undefined {
    const recorded = this.options.store.conversation(accountId, conversation.id);
    // A post without a recorded announcement (adopted from the link attribute, or its record was
    // cleared) cannot tell an unchanged assignee from a new one: do not ping. Its next
    // announcement records the current assignee.
    if (recorded?.threadId !== undefined && recorded.announcedAssignee === undefined) return undefined;
    if (recorded?.announcedAssignee === assigneeKey(conversation)) return undefined;
    return this.linkedAssignee(conversation);
  }

  /** The triage bot mention for a customer message, or a note when its hourly budget is used up. */
  private triage(message: RelayMessage): { mention?: string; note?: string } {
    const { triage, store } = this.options;
    if (!triage || !fromCustomer(message)) return {};
    // Count each message once: a retry after a failed post must not use up the budget.
    if (!store.firstAttempt(`triage:seen:${message.account.id}:${message.id}`)) return { mention: triage.userId };

    const hour = this.options.now().toISOString().slice(0, 13);
    const key = `${message.account.id}:${message.conversation.id}`;
    if (store.increment(`triage:${key}:${hour}`) > triage.perConversationPerHour) {
      return { note: conversationBudgetNote(triage) };
    }
    if (store.increment(`triage:${hour}`) > triage.perHour) return { note: hourlyBudgetNote(triage) };
    return { mention: triage.userId };
  }

  /** The linked Discord user of the conversation's assignee, if any. */
  private linkedAssignee(conversation: RelayConversation): string | undefined {
    const assigneeId = conversation.assignee?.id;
    return assigneeId ? this.options.linkedAgent?.(assigneeId)?.discordUserId : undefined;
  }
}

export function assignedLine(mention: string): string {
  return `-# Assigned to ${mention}`;
}

function conversationBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perConversationPerHour} customer messages in this conversation this hour. Ask it here if needed.`;
}

function hourlyBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perHour} customer messages this hour. Ask it here if needed.`;
}
