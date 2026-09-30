// "Use draft": the draft of the triage bot's answer the button is under, read when it is pressed.
// Reading another bot's message text needs the Message Content intent on this bot's application;
// without it Discord returns the triage bot's messages with empty content, which is told apart
// from an answer without a draft.

import {
  type RESTGetAPIChannelMessagesQuery,
  type RESTGetAPIChannelMessagesResult,
  Routes,
} from "discord-api-types/v10";
import type { DiscordRest } from "../discord/rest.ts";
import { lastCodeBlock } from "../relay/format.ts";

/**
 * Messages read back from the button's message. Its buttons are posted a moment after the answer,
 * so an activity line or two may come in between.
 */
const LOOK_BACK = 10;

export type Draft = { text: string } | { missing: "none" | "unreadable" };

/** The last code block of the triage bot's answer nearest above `messageId` (the button's message). */
export async function draftAbove(
  rest: DiscordRest,
  threadId: string,
  messageId: string,
  triageUserId: string | undefined,
): Promise<Draft> {
  if (!triageUserId) return { missing: "none" };
  const messages = await rest.get<RESTGetAPIChannelMessagesResult, RESTGetAPIChannelMessagesQuery>(
    Routes.channelMessages(threadId),
    { query: { before: messageId, limit: LOOK_BACK } },
  );
  // Newest first: the answer the button is under.
  const answer = messages.find((message) => message.author.id === triageUserId);
  if (!answer) return { missing: "none" };
  if (answer.content === "") return { missing: "unreadable" };
  const text = lastCodeBlock(answer.content);
  return text ? { text } : { missing: "none" };
}
