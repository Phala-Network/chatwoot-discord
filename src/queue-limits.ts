// Bounds of the support queue, apart from src/queue.ts so the configuration can check them.

/** Pages of open conversations read per account (CONVERSATIONS_PER_PAGE each). */
export const QUEUE_PAGES = 4;
/** Discord messages the queue may take; tickets beyond them are counted, not listed. */
export const QUEUE_MESSAGES = 4;

/** Requests one queue run needs: every account's pages, and its messages. */
export function queueBudget(accounts: number): number {
  return accounts * QUEUE_PAGES + QUEUE_MESSAGES;
}
