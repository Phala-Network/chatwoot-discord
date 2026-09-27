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

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: z.enum(["open", "resolved"]) }),
  z.object({ type: z.literal("block") }),
  z.object({ type: z.literal("assign"), email: z.string() }),
  z.object({ type: z.literal("message"), private: z.boolean(), content: z.string(), files: z.array(attachmentSchema) }),
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
