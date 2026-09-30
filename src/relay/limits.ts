// Worst-case subrequest counts of one conversation run (relay/processor.ts), kept in one place so
// the run's checks and the configuration's validation agree. A run starts a message only when
// the message's worst case fits in what is left of the invocation's budget (see budget.ts).

/**
 * Before the first message: the conversation, a check that the post linked from it exists
 * (recovery), the latest messages (an adopted post's starting point), and the first page.
 */
const SETUP_REQUESTS = 4;

/** Reading the next page of messages. */
export const PAGE_REQUESTS = 1;

/**
 * One message besides its parts: the linked sender's Discord avatar; for a new post, the inbox
 * name, the forum's tags, the bot's application id, the webhook's lookup and creation, the
 * ticket header, and the header again with the tags looked up again; a failed attempt into a post
 * deleted in Discord; the truncation note; the notice when the message is skipped; and what its
 * state adds (a customer's response or a delivery failure, see relay/updates.ts).
 */
const MESSAGE_REQUESTS = 13;

/**
 * After the messages: the notice that pings a new assignee and adding them to the post; linking
 * the post from its conversation (the forum's guild and the attribute update); and bringing the
 * post's tags, title, archived flag, and card up to date (the forum's tags, the update, the update
 * again with the tags looked up again, editing the card or looking for the post's cards, deleting
 * the previous one, posting it again, and archiving). Deleting more than one card, when an answer
 * to posting one was lost, may yield and continue in the next run.
 */
export const FINISH_REQUESTS = 2 + 2 + 7;

/** What one message may need, with room left to finish the run afterwards. */
export function requestsPerMessage(maxChunks: number): number {
  return maxChunks + MESSAGE_REQUESTS + FINISH_REQUESTS;
}

/** The smallest budget in which a run is sure to relay a message: the setup and one message. */
export function minimumBudget(maxChunks: number): number {
  return SETUP_REQUESTS + requestsPerMessage(maxChunks);
}
