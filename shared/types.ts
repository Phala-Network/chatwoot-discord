// The relay's view of a Chatwoot message plus the conversation state it is relayed with.
// Built from Chatwoot's REST API responses (see chatwoot/api.ts).

export type MessageType = "incoming" | "outgoing" | "activity" | "template";

export interface RelayAssignee {
  id?: number | undefined;
  name?: string | null | undefined;
}

/** A Chatwoot agent linked to a Discord user (`agents[]`). */
export interface LinkedAgent {
  discordUserId: string;
}

/** A file (its URL, and what it is when Chatwoot says), or a shared contact or location, which has no file. */
export type RelayAttachment =
  | { type: "file"; url: string; label?: string }
  | { type: "contact"; name: string; phone: string }
  | { type: "location"; title: string; latitude: number; longitude: number; url: string };

export interface RelayItem {
  title: string;
  description: string;
  url: string;
  /** A card's link buttons. */
  links: Array<{ text: string; url: string }>;
}

export interface RelayConversation {
  /** The conversation's display id (the number shown in Chatwoot). */
  id: number;
  /** open, pending, snoozed, or resolved. */
  status?: string | undefined;
  channel?: string | null;
  /** urgent, high, medium, low, or null. */
  priority?: string | null;
  labels: string[];
  contact: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    blocked?: boolean;
    avatarUrl?: string | null;
  };
  /** Person only; agent bots are represented as unassigned. */
  assignee?: RelayAssignee | null;
  assigneeType?: string | null;
  customAttributes: Record<string, unknown>;
}

export interface RelayMessage {
  id: number;
  /** Unix seconds. */
  createdAt?: number | null;
  messageType: MessageType;
  private: boolean;
  /** Deleted in Chatwoot (its content is replaced by a placeholder). */
  deleted?: boolean;
  content: string;
  emailSubject?: string | null;
  /** An automatic email reply (out of office, for example): relayed without notifications. */
  autoReply?: boolean;
  /** A qualifying public reply follows this message in Chatwoot. */
  answered?: boolean;
  attachments: RelayAttachment[];
  /** A bot's options to pick, cards, or articles, with a link each when they have one. */
  items?: RelayItem[];
  /** Chatwoot user id -> Discord user id of the linked agents a private note mentions. */
  mentionedAgents?: ReadonlyMap<number, string>;
  /** The Discord avatar of the linked agent who sent the message, if any. */
  discordAvatarUrl?: string;
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
