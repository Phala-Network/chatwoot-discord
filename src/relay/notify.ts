// Who a relayed message notifies, as lines added to its last part: the triage bot mention
// (within its hourly budgets), the linked assignee's ping on customer messages, and the
// announcement of a newly assigned agent. Only live messages notify; history relayed later (the
// first sync of an older conversation, a catch-up after downtime) is posted without them.

import { assigneeTag, fromCustomer } from "./format.ts";
import type { RelayStore } from "./relay.ts";
import type { RelayAssignee, RelayMessage } from "./types.ts";

export interface TriageOptions {
  userId: string;
  name: string;
  perConversationPerHour: number;
  perHour: number;
}

interface NotifierOptions {
  store: RelayStore;
  triage?: TriageOptions | undefined;
  /** The Discord user linked to a Chatwoot assignee, if any. */
  discordUserFor?: ((assignee: RelayAssignee) => string | undefined) | undefined;
  /** A message created longer ago than this is history. */
  liveSeconds: number;
  now: () => Date;
}

interface Notification {
  lines: string[];
  /** Users the lines may ping. */
  users: string[];
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
      assignedLine(LONGEST_MENTION),
      ...(triage ? [conversationBudgetNote(triage), hourlyBudgetNote(triage)] : []),
    ];
    this.reserve = lines.reduce((sum, line) => sum + line.length + 1, 0);
  }

  /** The notification lines for a message; the same on every attempt at posting it. */
  notification(message: RelayMessage): Notification {
    if (!this.live(message)) return { lines: [], users: [] };
    const announced = this.newAssignee(message);
    const assignee = fromCustomer(message) && !announced ? this.linkedAssignee(message) : undefined;
    const triage = this.triage(message);
    const mentions = [triage.mention, assignee].filter((id) => id !== undefined).map((id) => `<@${id}>`);
    const lines = [
      mentions.length > 0 ? `-# ${mentions.join(" ")}` : undefined,
      triage.note,
      announced ? assignedLine(`<@${announced}>`) : undefined,
    ].filter((line) => line !== undefined);
    // The triage mention stays a literal token: only the assignee may be pinged.
    const pinged = announced ?? assignee;
    return { lines, users: pinged ? [pinged] : [] };
  }

  /** Records that a posted message announced the conversation's assignee (history does not). */
  posted(message: RelayMessage): void {
    if (!this.live(message)) return;
    const { store } = this.options;
    const assignee = assigneeTag(message.conversation);
    if (store.announcedAssignee(message.account.id, message.conversation.id) !== assignee) {
      store.saveAnnouncedAssignee(message.account.id, message.conversation.id, assignee);
    }
  }

  private live(message: RelayMessage): boolean {
    if (message.createdAt === undefined || message.createdAt === null) return true;
    return this.options.now().getTime() - message.createdAt * 1000 <= this.options.liveSeconds * 1000;
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
  private linkedAssignee(message: RelayMessage): string | undefined {
    const assignee = message.conversation.assignee;
    return assignee?.id ? this.options.discordUserFor?.(assignee) : undefined;
  }

  /**
   * When the conversation has an assignee the post has not announced yet, their Discord id, so
   * the message pings them (which also adds them to the post).
   */
  private newAssignee(message: RelayMessage): string | undefined {
    const { store } = this.options;
    const accountId = message.account.id;
    const conversationId = message.conversation.id;
    // A post adopted from the link attribute has no recorded state, so an unchanged assignee
    // cannot be told apart from a new one: do not ping (its tags are still brought up to date).
    if (store.state(accountId, conversationId) === undefined && store.thread(accountId, conversationId)) {
      return undefined;
    }
    if (store.announcedAssignee(accountId, conversationId) === assigneeTag(message.conversation)) return undefined;
    return this.linkedAssignee(message);
  }
}

function assignedLine(mention: string): string {
  return `-# Assigned to ${mention}`;
}

function conversationBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perConversationPerHour} customer messages in this conversation this hour. Ask it here if needed.`;
}

function hourlyBudgetNote(triage: TriageOptions): string {
  return `-# ${triage.name} not called: more than ${triage.perHour} customer messages this hour. Ask it here if needed.`;
}
