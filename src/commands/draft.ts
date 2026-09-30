// "Use draft": the triage bot's latest draft in a post. Reading another bot's message text needs
// the Message Content intent on this bot's application; without it Discord returns the triage
// bot's messages with empty content, which is told apart from "no draft yet".

import {
  type RESTGetAPIChannelMessagesQuery,
  type RESTGetAPIChannelMessagesResult,
  Routes,
} from "discord-api-types/v10";
import type { DiscordRest } from "../discord/rest.ts";
import { lastCodeBlock } from "../relay/format.ts";

/** Messages read back from the end of a post. */
const RECENT = 50;

export type Draft = { text: string } | { missing: "none" | "unreadable" };

/** The last code block of the triage bot's newest message in the post that has one. */
export async function latestDraft(
  rest: DiscordRest,
  threadId: string,
  triageUserId: string | undefined,
): Promise<Draft> {
  if (!triageUserId) return { missing: "none" };
  const messages = await rest.get<RESTGetAPIChannelMessagesResult, RESTGetAPIChannelMessagesQuery>(
    Routes.channelMessages(threadId),
    { query: { limit: RECENT } },
  );
  // Newest first.
  const triage = messages.filter((message) => message.author.id === triageUserId);
  for (const message of triage) {
    const text = lastCodeBlock(message.content);
    if (text) return { text };
  }
  // The triage bot wrote here, but every message reads as empty: the intent is missing.
  const unreadable = triage.length > 0 && triage.every((message) => message.content === "");
  return { missing: unreadable ? "unreadable" : "none" };
}
