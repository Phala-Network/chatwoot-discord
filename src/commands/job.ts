// Work a command defers to the Durable Object: everything that talks to Chatwoot or downloads
// attachments. The invoker sees "thinking…" until the result replaces it. Jobs are stored as
// JSON, so they are validated when read back.

import { z } from "zod";

const attachmentSchema = z.object({
  url: z.string(),
  filename: z.string(),
  contentType: z.string().optional(),
  size: z.number(),
});
export type AttachmentRef = z.infer<typeof attachmentSchema>;

/** Chatwoot's conversation priorities (`Conversation.priorities`); null clears the priority. */
export const prioritySchema = z.enum(["urgent", "high", "medium", "low"]);

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    status: z.enum(["open", "resolved", "pending", "snoozed"]),
    /** Unix seconds when a snoozed conversation reopens; without it, the contact's next reply does. */
    snoozedUntil: z.number().int().optional(),
  }),
  z.object({ type: z.literal("priority"), priority: prioritySchema.nullable() }),
  z.object({ type: z.literal("block") }),
  z.object({ type: z.literal("unblock") }),
  z.object({ type: z.literal("assign"), chatwootUserId: z.number().int().positive() }),
  z.object({ type: z.literal("unassign") }),
  /** Adds or removes one label, by its name (Chatwoot's label names are lower-case). */
  z.object({ type: z.literal("label"), change: z.enum(["add", "remove"]), label: z.string().min(1) }),
  z.object({
    type: z.literal("message"),
    private: z.boolean(),
    content: z.string(),
    files: z.array(attachmentSchema),
    /** An email reply sent from the agent's own address (a Chatwoot build that reads it; see README). */
    sendAsAgent: z.boolean().optional(),
  }),
]);
export type CommandAction = z.infer<typeof actionSchema>;

export const commandJobSchema = z.object({
  interactionId: z.string(),
  applicationId: z.string(),
  /** Interaction token (valid 15 minutes) used to edit the deferred response. */
  token: z.string(),
  discordUserId: z.string(),
  accountId: z.number(),
  conversationId: z.number(),
  action: actionSchema,
});
export type CommandJob = z.infer<typeof commandJobSchema>;
