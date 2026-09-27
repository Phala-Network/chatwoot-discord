// Commands registered in the guild (see scripts/register-commands.ts). Guild commands only
// exist in that guild, so no `contexts` are needed.

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "discord-api-types/v10";

export const REPLY_WITH_THIS = "Reply with this";

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
  { type: ApplicationCommandType.Message, name: REPLY_WITH_THIS },
];
