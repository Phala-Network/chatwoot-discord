// Runs a deferred command against Chatwoot as the invoking agent, using that agent's own access
// token, so Chatwoot applies its normal permissions and records who did it.

import { ChatwootError, chatwootClient, type Fetch } from "../chatwoot/api.js";
import type { Settings } from "../config.js";
import { errorFields, log } from "../log.js";
import { downloadAttachment } from "./attachments.js";
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
    if (!profile.accounts.some((account) => account.id === accountId)) throw new UserError(NOT_LINKED);
    const agentName = profile.available_name || profile.name;

    let message: string;
    switch (action.type) {
      case "status":
        await chatwoot.setStatus(accountId, conversationId, action.status);
        message = action.status === "resolved" ? "Resolved." : "Reopened.";
        break;
      case "block":
        await chatwoot.mute(accountId, conversationId);
        message = "Contact blocked and conversation resolved. Their new messages will not be posted here.";
        break;
      case "assign": {
        const agents = await chatwoot.listAgents(accountId);
        const assignee = agents.find((agent) => agent.email.toLowerCase() === action.email);
        if (!assignee) throw new UserError("That agent is not in this Chatwoot account.");
        await chatwoot.assign(accountId, conversationId, assignee.id);
        message = `Assigned to ${assignee.available_name || assignee.name}.`;
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
          const conversation = await chatwoot.getConversation(accountId, conversationId);
          if (!conversation.meta?.assignee) await chatwoot.assign(accountId, conversationId, profile.id);
        }
        await chatwoot.createMessage(accountId, conversationId, {
          content: action.content,
          private: action.private,
          files,
        });
        message = action.private ? "Note added." : `Sent to the customer as ${agentName}.`;
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
