// Lists a forum channel's tags with their ids, to fill in `forumTags` (tags are bound by id, and
// Discord's app does not show tag ids):
//
//   DISCORD_BOT_TOKEN=... npm run forum-tags -- --forum <forum channel id>

import { parseArgs } from "node:util";
import { type RESTGetAPIChannelResult, Routes } from "discord-api-types/v10";
import { DiscordRest } from "../src/discord/rest.ts";

const { values } = parseArgs({ options: { forum: { type: "string" } } });
const token = process.env.DISCORD_BOT_TOKEN;

if (!token || !values.forum || !/^\d{17,20}$/.test(values.forum)) {
  console.error("Usage: DISCORD_BOT_TOKEN=... npm run forum-tags -- --forum <forum channel id>");
  process.exit(2);
}

try {
  const channel = await new DiscordRest(token, (request) => fetch(request)).get<RESTGetAPIChannelResult>(
    Routes.channel(values.forum),
  );
  if (!("available_tags" in channel)) throw new Error("this channel is not a forum");
  // Tag name -> id, to map by what each tag stands for ("status:open": "<id>").
  console.log(JSON.stringify(Object.fromEntries(channel.available_tags.map((tag) => [tag.name, tag.id])), null, 2));
} catch (error) {
  console.error(`Listing the tags failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
