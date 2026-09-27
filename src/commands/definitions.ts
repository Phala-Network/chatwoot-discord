// Commands registered in the guild (see scripts/register-commands.ts). Guild commands only
// exist in that guild, so no `contexts` are needed.

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "discord-api-types/v10";

export const REPLY_WITH_THIS = "Reply with this";

/** Chatwoot's priority options and their dashboard names ("none" clears the priority). */
export const PRIORITY_NAMES = { none: "None", urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

/**
 * The dashboard's snooze options (SNOOZE_OPTIONS in dashboard/constants/globals.js at v4.18.0)
 * that do not depend on the agent's time zone. The others reopen at 9 AM in the browser's time
 * zone, which an interaction does not carry.
 */
export const SNOOZE_NAMES = { until_next_reply: "Until next reply", an_hour_from_now: "Until an hour from now" };

const slash = ApplicationCommandType.ChatInput;

export const COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
  { type: slash, name: "reply", description: "Reply to the customer (text and attachments)" },
  {
    type: slash,
    name: "note",
    description: "Add a private note, optionally with attachments (only agents see it)",
  },
  { type: slash, name: "resolve", description: "Resolve the conversation" },
  { type: slash, name: "reopen", description: "Reopen the conversation" },
  { type: slash, name: "pending", description: "Mark the conversation as pending" },
  {
    type: slash,
    name: "snooze",
    description: "Snooze the conversation (default: until the next reply)",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "until",
        description: "When it reopens (a reply from the contact always reopens it)",
        choices: Object.entries(SNOOZE_NAMES).map(([value, name]) => ({ name, value })),
      },
    ],
  },
  {
    type: slash,
    name: "priority",
    description: "Set the conversation priority",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "level",
        description: "Priority",
        required: true,
        choices: Object.entries(PRIORITY_NAMES).map(([value, name]) => ({ name, value })),
      },
    ],
  },
  {
    type: slash,
    name: "assign",
    description: "Assign the conversation (default: to you)",
    options: [{ type: ApplicationCommandOptionType.User, name: "agent", description: "Agent to assign" }],
  },
  {
    type: slash,
    name: "block",
    description: "Block this contact (spam): resolve and mute their future messages",
  },
  { type: slash, name: "unblock", description: "Unblock this contact so their new messages are posted again" },
  { type: ApplicationCommandType.Message, name: REPLY_WITH_THIS },
];
