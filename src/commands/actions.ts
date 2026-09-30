// Runs a deferred command against Chatwoot as the invoking agent, using that agent's own access
// token, so Chatwoot applies its normal permissions and records who did it.

import { type ChatwootClient, ChatwootError, chatwootClient, type Fetch, type StatusChange } from "../chatwoot/api.ts";
import type { Settings } from "../config.ts";
import { errorFields, log } from "../log.ts";
import { downloadAttachment } from "./attachments.ts";
import { FAILED, filesTooLarge, NOT_LINKED, UserError } from "./common.ts";
import { type ActionRow, panelRows } from "./components.ts";
import { PRIORITY_NAMES } from "./definitions.ts";
import type { CommandJob } from "./job.ts";

interface CommandResult {
  /** The confirmation shown to the invoker (only they see it). */
  content: string;
  /** The Manage panel, drawn with the ticket as it is now (panel jobs that succeeded). */
  components?: ActionRow[];
  /** Chatwoot could not find the conversation: it may have been deleted. */
  conversationGone: boolean;
}

/** Never throws. */
export async function executeCommand(job: CommandJob, settings: Settings, fetch: Fetch): Promise<CommandResult> {
  // The link is checked again here: it may have changed since the command was queued.
  const chatwootUserId = settings.chatwootUserFor(job.discordUserId);
  const token = settings.agentToken(job.discordUserId);
  if (chatwootUserId === undefined || !token) return { content: `❌ ${NOT_LINKED}`, conversationGone: false };
  const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, token, fetch);
  const { accountId, conversationId, action } = job;

  try {
    const profile = await chatwoot.getProfile();
    if (profile.id === undefined) throw new UserError(NOT_LINKED);
    // A token stored for the wrong Discord user would act as someone else.
    if (profile.id !== chatwootUserId) {
      log.error("agent token belongs to another Chatwoot user", { discordUserId: job.discordUserId, chatwootUserId });
      throw new UserError(TOKEN_MISMATCH);
    }
    // The token works, but its user was removed from the account (or never was in it).
    if (!profile.accounts?.some((account) => account.id === accountId)) throw new UserError(NOT_IN_ACCOUNT);

    let message = "";
    switch (action.type) {
      case "panel":
        break;
      case "labels": {
        // Relative to what the panel showed, so labels someone changed meanwhile are kept.
        const current = await chatwoot.conversationLabels(accountId, conversationId);
        const known = await chatwoot.listLabels(accountId);
        const unknown = action.add.find((label) => !known.includes(label));
        if (unknown !== undefined) throw new UserError(`There is no label "${unknown}" in this Chatwoot account.`);
        const labels = [...new Set([...current, ...action.add])].filter((label) => !action.remove.includes(label));
        await chatwoot.setLabels(accountId, conversationId, labels);
        message = labelsMessage(action.add, action.remove);
        break;
      }
      case "status": {
        const { status, snoozedUntil } = action;
        await chatwoot.setStatus(
          accountId,
          conversationId,
          snoozedUntil === undefined ? { status } : { status, snoozed_until: snoozedUntil },
        );
        message = statusMessage(status, snoozedUntil);
        break;
      }
      case "priority":
        await chatwoot.setPriority(accountId, conversationId, action.priority);
        message = action.priority ? `Priority set to ${PRIORITY_NAMES[action.priority]}.` : "Priority removed.";
        break;
      case "block": {
        // What Chatwoot's "Block contact" does (Conversation#mute!), through the documented API:
        // resolve the conversation and set the contact's `blocked` flag.
        const contactId = (await existing(chatwoot.getConversation(accountId, conversationId))).meta?.sender?.id;
        if (contactId === undefined) throw new UserError("This conversation has no contact to block.");
        await chatwoot.setStatus(accountId, conversationId, { status: "resolved" });
        await chatwoot.setContactBlocked(accountId, contactId, true);
        message = "Contact blocked and conversation resolved. Their new messages will not be posted here.";
        break;
      }
      case "unblock": {
        // Chatwoot's "Unblock contact": clears the contact's `blocked` flag; the conversation stays as it is.
        const contactId = (await existing(chatwoot.getConversation(accountId, conversationId))).meta?.sender?.id;
        if (contactId === undefined) throw new UserError("This conversation has no contact to unblock.");
        await chatwoot.setContactBlocked(accountId, contactId, false);
        message = "Contact unblocked. Their new messages will be posted here again.";
        break;
      }
      case "assign": {
        // Chatwoot assigns a user who is not an agent of the account as no one (it unassigns:
        // Conversations::AssignmentService at v4.18.0), so membership is checked first.
        const agents = await chatwoot.listAgents(accountId);
        const assignee = agents.find((agent) => agent.id === action.chatwootUserId);
        if (!assignee) throw new UserError("That agent is not in this Chatwoot account.");
        await chatwoot.assign(accountId, conversationId, action.chatwootUserId);
        // The name Chatwoot shows as the assignee, which is also the post's assignee tag.
        message = `Assigned to ${assignee.name ?? "the agent"}.`;
        break;
      }
      case "unassign":
        await chatwoot.unassign(accountId, conversationId);
        message = "Unassigned.";
        break;
      case "label": {
        // Chatwoot sets a conversation's labels as a whole list.
        const { change, label } = action;
        const current = await chatwoot.conversationLabels(accountId, conversationId);
        if (change === "add") {
          const known = await chatwoot.listLabels(accountId);
          if (!known.includes(label)) throw new UserError(`There is no label "${label}" in this Chatwoot account.`);
          if (!current.includes(label)) await chatwoot.setLabels(accountId, conversationId, [...current, label]);
          message = `Label ${label} added.`;
        } else {
          if (!current.includes(label)) throw new UserError(`This conversation has no label "${label}".`);
          await chatwoot.setLabels(
            accountId,
            conversationId,
            current.filter((name) => name !== label),
          );
          message = `Label ${label} removed.`;
        }
        break;
      }
      case "message": {
        if (!action.private) {
          const conversation = await existing(chatwoot.getConversation(accountId, conversationId));
          // Chatwoot accepts the message but the channel would fail it, e.g. after WhatsApp's
          // 24-hour window (Conversations::MessageWindowService at v4.18.0).
          if (conversation.can_reply === false) throw new UserError(CANNOT_REPLY);
          // A public reply to an unassigned conversation assigns it to the replying agent.
          if (!conversation.meta?.assignee) await chatwoot.assign(accountId, conversationId, profile.id);
        }
        const limits = settings.config.attachments;
        const files = [];
        let total = 0;
        for (const file of action.files) {
          const downloaded = await downloadAttachment(file, limits.maxFileBytes, fetch);
          total += downloaded.blob.size;
          if (total > limits.maxTotalBytes) throw filesTooLarge(limits.maxTotalBytes);
          files.push(downloaded);
        }
        await chatwoot.createMessage(accountId, conversationId, {
          content: action.content,
          private: action.private,
          files,
          sendAsAgent: action.sendAsAgent === true,
        });
        // Customers see an agent's display name (`available_name`).
        message = action.private ? "Note added." : `Sent to the customer as ${profile.available_name || profile.name}.`;
        break;
      }
    }
    log.info("command done", { action: action.type, discordUserId: job.discordUserId, accountId, conversationId });
    if (job.panel || action.type === "panel") {
      const title = `⚙️ **${settings.account(accountId)?.name ?? "Ticket"} #${conversationId}**`;
      return {
        content: message ? `${title}\n✅ ${message}` : title,
        components: await panel(chatwoot, accountId, conversationId),
        conversationGone: false,
      };
    }
    return { content: `✅ ${message}`, conversationGone: false };
  } catch (error) {
    const gone = error instanceof ConversationGoneError || (error instanceof ChatwootError && error.status === 404);
    return { content: failure(error, job), conversationGone: gone };
  }
}

function failure(error: unknown, { action, accountId, conversationId }: CommandJob): string {
  if (error instanceof UserError) return `❌ ${error.message}`;
  if (error instanceof ChatwootError && error.status === 401) {
    return "❌ Chatwoot rejected your access token. Ask an admin to update it.";
  }
  if (error instanceof ChatwootError && (error.status === 403 || error.status === 404)) {
    return "❌ You do not have access to this conversation.";
  }
  log.error("command failed", { action: action.type, accountId, conversationId, ...errorFields(error) });
  // A request that timed out may still have been carried out.
  if (error instanceof DOMException && error.name === "TimeoutError") return TIMED_OUT;
  return FAILED;
}

const TIMED_OUT =
  "❌ Chatwoot or Discord did not answer in time. Check in Chatwoot whether it was done before trying again.";

/** The Manage panel for the conversation as it is now. */
async function panel(chatwoot: ChatwootClient, accountId: number, conversationId: number): Promise<ActionRow[]> {
  const conversation = await existing(chatwoot.getConversation(accountId, conversationId));
  const agents = await chatwoot.listAgents(accountId);
  const labels = await chatwoot.listLabels(accountId);
  return panelRows(
    {
      assigneeId: conversation.meta?.assignee?.id ?? null,
      labels: conversation.labels ?? [],
      priority: conversation.priority ?? null,
      status: conversation.status ?? "open",
    },
    agents.flatMap((agent) => (agent.id === undefined ? [] : [{ id: agent.id, name: agent.name ?? `#${agent.id}` }])),
    labels,
  );
}

function labelsMessage(added: string[], removed: string[]): string {
  const parts = [
    ...(added.length > 0 ? [`added ${added.join(", ")}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(", ")}`] : []),
  ];
  return parts.length > 0 ? `Labels ${parts.join("; ")}.` : "Labels unchanged.";
}

function statusMessage(status: StatusChange["status"], snoozedUntil: number | undefined): string {
  switch (status) {
    case "open":
      return "Reopened.";
    case "resolved":
      return "Resolved.";
    case "pending":
      return "Marked as pending.";
    case "snoozed":
      // Discord shows the timestamp in each reader's own time zone.
      return snoozedUntil === undefined ? "Snoozed until the next reply." : `Snoozed until <t:${snoozedUntil}:f>.`;
  }
}

const TOKEN_MISMATCH =
  "Your Chatwoot access token belongs to another Chatwoot user, so nothing was done. Ask an admin to fix your link.";

const NOT_IN_ACCOUNT =
  "Your Chatwoot user is no longer an agent in this Chatwoot account. Ask an admin to add you back, or to unlink your Discord account.";

const CANNOT_REPLY =
  "This conversation's channel does not accept a reply right now (for example, its reply window has closed). Reply in Chatwoot, for example with a template.";

class ConversationGoneError extends UserError {
  constructor() {
    super("This conversation no longer exists in Chatwoot.");
  }
}

async function existing<T>(conversation: Promise<T | undefined>): Promise<T> {
  const found = await conversation;
  if (found === undefined) throw new ConversationGoneError();
  return found;
}
