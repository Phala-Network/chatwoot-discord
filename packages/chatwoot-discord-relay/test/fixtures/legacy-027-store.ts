// Exact v0.27.0 conversation reader: schema9 has no assignee_notice_id.
import { Store } from "../../src/store.ts";
export class Legacy027Store extends Store {
  override conversation(accountId: number, conversationId: number): ReturnType<Store["conversation"]> {
    const row = this.sql
      .exec<{
        thread_id: string | null;
        state: string | null;
        cursor: number | null;
        announced_assignee: string | null;
        announce_pending: number | null;
        title_subject: string | null;
        title: string | null;
        title_message_id: number | null;
        card_id: string | null;
        card_covered: number | null;
        answer_id: string | null;
        answer_source_id: string | null;
        customer_message_id: string | null;
      }>(
        `SELECT thread_id,state,cursor,announced_assignee,announce_pending,title_subject,title,title_message_id,card_id,card_covered,answer_id,answer_source_id,customer_message_id FROM conversations
         WHERE account_id = ? AND conversation_id = ?`,
        accountId,
        conversationId,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      assigneeNoticeId: undefined, // Absent in the actual schema9 reader.
      threadId: row.thread_id ?? undefined,
      state: row.state ?? undefined,
      cursor: row.cursor ?? undefined,
      announcedAssignee: row.announced_assignee ?? undefined,
      announcePending: row.announce_pending ?? undefined,
      titleSubject: row.title_subject ?? undefined,
      title: row.title ?? undefined,
      titleMessageId: row.title_message_id ?? undefined,
      cardId: row.card_id ?? undefined,
      cardCovered: row.card_covered ?? undefined,
      answerId: row.answer_id ?? undefined,
      answerSourceId: row.answer_source_id ?? undefined,
      customerMessageId: row.customer_message_id ?? undefined,
    };
  }

  /** Sets the given fields of a conversation's row. */
}
