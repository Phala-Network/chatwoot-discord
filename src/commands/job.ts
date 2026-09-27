// Work a command defers to the Durable Object: everything that talks to Chatwoot or downloads
// attachments. The invoker sees "thinking…" until the result replaces it.

export interface AttachmentRef {
  url: string;
  filename: string;
  contentType?: string;
  size: number;
}

export type CommandAction =
  | { type: "status"; status: "open" | "resolved" }
  | { type: "block" }
  | { type: "assign"; email: string }
  | { type: "message"; private: boolean; content: string; files: AttachmentRef[] };

export interface CommandJob {
  interactionId: string;
  applicationId: string;
  /** Interaction token (valid 15 minutes) used to edit the deferred response. */
  token: string;
  discordUserId: string;
  accountId: number;
  conversationId: number;
  /** "Account #12", for confirmations and logs. */
  ticketTitle: string;
  action: CommandAction;
}
