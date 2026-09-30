// "Use draft": the draft of the triage bot's answer its button is under. The bot's hook sends the
// draft with the answer (see Hub.triageAnswered), and it is kept for a while; otherwise it is read
// from the answer, which needs the Message Content intent on this bot's application (without it
// Discord returns another bot's message with empty content, and the answer is linked instead).

import { type RESTGetAPIChannelMessageResult, Routes } from "discord-api-types/v10";
import type { DiscordRest } from "../discord/rest.ts";
import { lastCodeBlock } from "../relay/format.ts";

export type Draft = { text: string } | { missing: "none" } | { missing: "unreadable" };

/** The answer's draft (its last code block), read from Discord at once: someone is waiting. */
export async function readDraft(
  rest: DiscordRest,
  threadId: string,
  answerId: string,
  triageUserId: string | undefined,
): Promise<Draft> {
  const answer = await rest.get<RESTGetAPIChannelMessageResult>(Routes.channelMessage(threadId, answerId), {
    retry: false,
  });
  if (!triageUserId || answer.author.id !== triageUserId) return { missing: "none" };
  if (answer.content === "") return { missing: "unreadable" };
  const text = lastCodeBlock(answer.content);
  return text ? { text } : { missing: "none" };
}
