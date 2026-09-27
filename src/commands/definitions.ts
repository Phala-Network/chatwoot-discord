// Commands registered in the guild (see scripts/register-commands.ts). Guild commands only
// exist in that guild, so no `contexts` are needed.

import {
  type APIApplicationCommandOption,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "discord-api-types/v10";

export const REPLY_WITH_THIS = "Reply with this";

/** Longest reply or note text accepted from Discord. */
export const CONTENT_MAX = 4000;

/** Longest label name accepted from Discord. */
const LABEL_MAX = 100;

/** Chatwoot's priority options and their dashboard names ("none" clears the priority). */
export const PRIORITY_NAMES = { none: "None", urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

/**
 * The dashboard's snooze options (SNOOZE_OPTIONS in dashboard/constants/globals.js at v4.18.0)
 * that do not depend on the agent's time zone. The others reopen at 9 AM in the browser's time
 * zone, which an interaction does not carry.
 */
const SNOOZE_NAMES = { until_next_reply: "Until next reply", an_hour_from_now: "Until an hour from now" };

const slash = ApplicationCommandType.ChatInput;

/** Sends at once instead of opening the editor (a string option is a single line). */
const INLINE_OPTIONS: APIApplicationCommandOption[] = [
  {
    type: ApplicationCommandOptionType.String,
    name: "message",
    description: "Send this text now (single line); leave both options empty to open the editor",
    max_length: CONTENT_MAX,
  },
  { type: ApplicationCommandOptionType.Attachment, name: "attachment", description: "Send this file now" },
];

export const COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
  {
    type: slash,
    name: "reply",
    description: "Reply to the customer (text and attachments)",
    options: INLINE_OPTIONS,
  },
  {
    type: slash,
    name: "note",
    description: "Add a private note, optionally with attachments (only agents see it)",
    options: INLINE_OPTIONS,
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
  { type: slash, name: "unassign", description: "Remove the conversation's assignee" },
  {
    type: slash,
    name: "label",
    description: "Add or remove a label",
    options: (["add", "remove"] as const).map((change) => ({
      type: ApplicationCommandOptionType.Subcommand,
      name: change,
      description: change === "add" ? "Add a label to the conversation" : "Remove a label from the conversation",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "label",
          description: "The label's name in Chatwoot",
          required: true,
          max_length: LABEL_MAX,
        },
      ],
    })),
  },
  {
    type: slash,
    name: "block",
    description: "Block this contact (spam): resolve and mute their future messages",
  },
  { type: slash, name: "unblock", description: "Unblock this contact so their new messages are posted again" },
  { type: ApplicationCommandType.Message, name: REPLY_WITH_THIS },
];
