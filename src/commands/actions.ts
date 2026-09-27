// Runs a deferred command against Chatwoot as the invoking agent, using that agent's own access
// token, so Chatwoot applies its normal permissions and records who did it.

import { ChatwootError, chatwootClient, type Fetch, type StatusChange } from "../chatwoot/api.js";
import type { Settings } from "../config.js";
import { errorFields, log } from "../log.js";
import { downloadAttachment } from "./attachments.js";
import { PRIORITY_NAMES } from "./definitions.js";
import { FAILED, NOT_LINKED, UserError } from "./handler.js";
import type { CommandJob } from "./job.js";

/** The confirmation shown to the invoker (only they see it). Never throws. */
export async function executeCommand(job: CommandJob, settings: Settings, fetch: Fetch): Promise<string> {
  const token = settings.agentToken(job.discordUserId);
  if (!token) return `❌ ${NOT_LINKED}`;
  const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, token, fetch);
  const { accountId, conversationId, action } = job;

  try {
    const profile = await chatwoot.getProfile();
    if (profile.id === undefined || !profile.accounts?.some((account) => account.id === accountId)) {
      throw new UserError(NOT_LINKED);
    }

    let message: string;
    switch (action.type) {
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
        const agents = await chatwoot.listAgents(accountId);
        const assignee = agents.find((agent) => agent.email?.toLowerCase() === action.email);
        if (assignee?.id === undefined) throw new UserError("That agent is not in this Chatwoot account.");
        await chatwoot.assign(accountId, conversationId, assignee.id);
        // The name Chatwoot shows as the assignee, which is also the post's assignee tag.
        message = `Assigned to ${assignee.name ?? action.email}.`;
        break;
      }
      case "message": {
        const limits = settings.config.attachments;
        const files = [];
        let total = 0;
        for (const file of action.files) {
          const downloaded = await downloadAttachment(file, limits.maxFileBytes, fetch);
          total += downloaded.blob.size;
          if (total > limits.maxTotalBytes) {
            throw new UserError(
              `Attachments must add up to ${Math.floor(limits.maxTotalBytes / (1024 * 1024))} MB or less.`,
            );
          }
          files.push(downloaded);
        }
        if (!action.private) {
          // A public reply to an unassigned conversation assigns it to the replying agent.
          const conversation = await existing(chatwoot.getConversation(accountId, conversationId));
          if (!conversation.meta?.assignee) await chatwoot.assign(accountId, conversationId, profile.id);
        }
        await chatwoot.createMessage(accountId, conversationId, {
          content: action.content,
          private: action.private,
          files,
        });
        // Customers see an agent's display name (`available_name`).
        message = action.private ? "Note added." : `Sent to the customer as ${profile.available_name || profile.name}.`;
        break;
      }
    }
    log.info("command done", { action: action.type, discordUserId: job.discordUserId, accountId, conversationId });
    return `✅ ${message}`;
  } catch (error) {
    if (error instanceof UserError) return `❌ ${error.message}`;
    if (error instanceof ChatwootError && error.status === 401) {
      return "❌ Chatwoot rejected your access token. Ask an admin to update it.";
    }
    if (error instanceof ChatwootError && (error.status === 403 || error.status === 404)) {
      return "❌ You do not have access to this conversation.";
    }
    log.error("command failed", { action: action.type, accountId, conversationId, ...errorFields(error) });
    return FAILED;
  }
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

async function existing<T>(conversation: Promise<T | undefined>): Promise<T> {
  const found = await conversation;
  if (found === undefined) throw new UserError("This conversation no longer exists in Chatwoot.");
  return found;
}
