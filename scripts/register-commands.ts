// Registers the slash commands and the "Reply with this" message command in one guild (bulk
// overwrite). Run manually after changing src/commands/definitions.ts:
//
//   DISCORD_BOT_TOKEN=... pnpm register-commands --application <app id> --guild <guild id>

import { parseArgs } from "node:util";
import {
  type RESTPutAPIApplicationGuildCommandsJSONBody,
  type RESTPutAPIApplicationGuildCommandsResult,
  Routes,
} from "discord-api-types/v10";
import { COMMANDS } from "../src/commands/definitions.js";
import { DiscordRest } from "../src/discord/rest.js";

const { values } = parseArgs({
  options: {
    application: { type: "string", default: process.env.DISCORD_APPLICATION_ID },
    guild: { type: "string", default: process.env.DISCORD_GUILD_ID },
  },
});
const token = process.env.DISCORD_BOT_TOKEN;
const snowflake = /^\d{17,20}$/;

if (
  !token ||
  !values.application ||
  !values.guild ||
  !snowflake.test(values.application) ||
  !snowflake.test(values.guild)
) {
  console.error("Usage: DISCORD_BOT_TOKEN=... pnpm register-commands --application <app id> --guild <guild id>");
  process.exit(2);
}

try {
  const rest = new DiscordRest(token, (request) => fetch(request));
  const registered = await rest.put<
    RESTPutAPIApplicationGuildCommandsResult,
    RESTPutAPIApplicationGuildCommandsJSONBody
  >(Routes.applicationGuildCommands(values.application, values.guild), { body: COMMANDS });
  console.log(`Registered ${registered.length} commands in guild ${values.guild}.`);
} catch (error) {
  console.error(`Registration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
