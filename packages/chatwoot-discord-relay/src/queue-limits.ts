// Bounds of the support queue, apart from src/queue.ts so the configuration can check them.

/** Pages of open conversations read per account (CONVERSATIONS_PER_PAGE each). */
export const QUEUE_PAGES = 4;
/** Pages of snoozed conversations read per account. */
export const SNOOZED_PAGES = 1;
/** Pages of pending bot conversations read per account. */
export const PENDING_PAGES = 1;
/** Discord messages the queue may take; tickets beyond them are counted, not listed. */
export const QUEUE_MESSAGES = 4;
