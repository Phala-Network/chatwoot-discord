// "Reply with draft": the triage bot's latest draft in a post. Reading another bot's message
// text needs the Message Content intent (on the bot's Discord application).

import {
  type RESTGetAPIChannelMessagesQuery,
  type RESTGetAPIChannelMessagesResult,
  Routes,
} from "discord-api-types/v10";
import type { DiscordRest } from "../discord/rest.ts";
import { lastCodeBlock } from "../relay/format.ts";

/** Messages read back from the end of a post. */
const RECENT = 50;

/** The last code block of the triage bot's newest message in the post that has one. */
export async function latestDraft(
  rest: DiscordRest,
  threadId: string,
  triageUserId: string | undefined,
): Promise<string | undefined> {
  if (!triageUserId) return undefined;
  const messages = await rest.get<RESTGetAPIChannelMessagesResult, RESTGetAPIChannelMessagesQuery>(
    Routes.channelMessages(threadId),
    { query: { limit: RECENT } },
  );
  // Newest first.
  for (const message of messages) {
    if (message.author.id !== triageUserId) continue;
    const draft = lastCodeBlock(message.content);
    if (draft) return draft;
  }
  return undefined;
}
