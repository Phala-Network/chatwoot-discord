// The relay's view of a Chatwoot message plus the conversation state it is relayed with.
// Built from Chatwoot's REST API responses (see chatwoot/api.ts).

export type MessageType = "incoming" | "outgoing" | "activity" | "template";

export interface RelayAssignee {
  id?: number | undefined;
  name?: string | null | undefined;
  email?: string | null | undefined;
}

export interface RelayConversation {
  /** The conversation's display id (the number shown in Chatwoot). */
  id: number;
  status: string;
  channel?: string | null;
  inboxId?: number | null;
  contact: { name?: string | null; email?: string | null; blocked?: boolean };
  assignee?: RelayAssignee | null;
  customAttributes: Record<string, unknown>;
}

export interface RelayMessage {
  id: number;
  messageType: MessageType;
  private: boolean;
  content: string;
  emailSubject?: string | null;
  attachmentUrls: string[];
  sender?:
    | {
        name?: string | null | undefined;
        email?: string | null | undefined;
        type?: string | null | undefined;
        avatarUrl?: string | null | undefined;
      }
    | undefined;
  account: { id: number; name: string };
  inboxName?: string | null;
  conversation: RelayConversation;
}
