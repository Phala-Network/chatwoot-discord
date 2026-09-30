// "Use draft" under a customer message: the draft of the triage bot's answer to it. The bot
// answers as a Discord reply to the message, so the answer is found by that reference, which
// Discord always shows. Its text needs the Message Content intent on this bot's application:
// without it Discord returns another bot's message with empty content, and the button links to the
// answer, whose draft "Reply with this" takes.

import {
  type RESTGetAPIChannelMessagesQuery,
  type RESTGetAPIChannelMessagesResult,
  Routes,
} from "discord-api-types/v10";
import type { DiscordRest } from "../discord/rest.ts";
import { lastCodeBlock } from "../relay/format.ts";

/** Messages read after the customer message, for the answer. */
const LOOK_AHEAD = 50;

export type Draft =
  | { text: string }
  | { missing: "unanswered" | "none" }
  /** The answer's text cannot be read: `answerId` is the answer, to take its draft by hand. */
  | { missing: "unreadable"; answerId: string };

/** The draft (last code block) of the triage bot's answer to `messageId`. */
export async function draftFor(
  rest: DiscordRest,
  threadId: string,
  messageId: string,
  triageUserId: string | undefined,
): Promise<Draft> {
  if (!triageUserId) return { missing: "unanswered" };
  const messages = await rest.get<RESTGetAPIChannelMessagesResult, RESTGetAPIChannelMessagesQuery>(
    Routes.channelMessages(threadId),
    { query: { after: messageId, limit: LOOK_AHEAD } },
  );
  // The newest answer to the message, should the bot have answered it twice.
  const answer = messages.find(
    (message) => message.author.id === triageUserId && message.message_reference?.message_id === messageId,
  );
  if (!answer) return { missing: "unanswered" };
  if (answer.content === "") return { missing: "unreadable", answerId: answer.id };
  const text = lastCodeBlock(answer.content);
  return text ? { text } : { missing: "none" };
}
