// Turns one Discord interaction into an immediate response, plus a deferred job for anything
// that has to talk to Chatwoot. Runs in the Worker, so it must stay fast (Discord waits 3 s).

import {
  type APIApplicationCommandInteraction,
  type APIAttachment,
  type APIInteraction,
  type APIInteractionResponse,
  type APIModalInteractionResponse,
  type APIModalSubmitInteraction,
  ApplicationCommandType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  TextInputStyle,
} from "discord-api-types/v10";
import type { Settings } from "../config.js";
import { draftFromMessage, draftFromTriage } from "../relay/format.js";
import { REPLY_WITH_THIS } from "./definitions.js";
import type { AttachmentRef, CommandAction, CommandJob } from "./job.js";

export const CONTENT_MAX = 4000;
export const FAILED = "❌ That did not work. Please do it in Chatwoot.";
export const NOT_LINKED = "Your Discord account is not linked to a Chatwoot agent.";
export const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export interface Ticket {
  accountId: number;
  conversationId: number;
}

export interface HandlerDeps {
  settings: Settings;
  /** The conversation the relay mapped to this forum post, if any. */
  ticketForThread(threadId: string): Promise<Ticket | undefined>;
}

export interface HandlerResult {
  response: APIInteractionResponse;
  job?: CommandJob;
}

/** A problem the invoker should see. Other errors get a generic message. */
export class UserError extends Error {}

export async function handleInteraction(interaction: APIInteraction, deps: HandlerDeps): Promise<HandlerResult> {
  if (interaction.type === InteractionType.Ping) return { response: { type: InteractionResponseType.Pong } };
  if (interaction.type !== InteractionType.ApplicationCommand && interaction.type !== InteractionType.ModalSubmit) {
    return privately("Unsupported interaction.");
  }

  try {
    const threadId = interaction.channel?.id ?? interaction.channel_id;
    const ticket = threadId ? await deps.ticketForThread(threadId) : undefined;
    const account = ticket && deps.settings.account(ticket.accountId);
    if (!ticket || !account) return privately("Use this command inside a ticket post in the Chatwoot forum.");

    const userId = invokerId(interaction);
    if (!userId || !deps.settings.agentEmail(userId) || !deps.settings.agentToken(userId)) return privately(NOT_LINKED);

    const context: Context = {
      deps,
      interaction,
      userId,
      ticket,
      title: `${account.name} #${ticket.conversationId}`,
    };
    return interaction.type === InteractionType.ModalSubmit
      ? submit(context, interaction)
      : command(context, interaction);
  } catch (error) {
    if (error instanceof UserError) return privately(`❌ ${error.message}`);
    throw error;
  }
}

interface Context {
  deps: HandlerDeps;
  interaction: APIApplicationCommandInteraction | APIModalSubmitInteraction;
  userId: string;
  ticket: Ticket;
  title: string;
}

function command(context: Context, interaction: APIApplicationCommandInteraction): HandlerResult {
  const { data } = interaction;
  if (data.type === ApplicationCommandType.Message) {
    return data.name === REPLY_WITH_THIS ? replyWithThis(context, interaction) : privately("Unknown command.");
  }
  switch (data.name) {
    case "reply":
      return { response: editor(context, "reply", undefined) };
    case "note":
      return { response: editor(context, "note", undefined) };
    case "resolve":
      return defer(context, { type: "status", status: "resolved" });
    case "reopen":
      return defer(context, { type: "status", status: "open" });
    case "block":
      return defer(context, { type: "block" });
    case "assign": {
      const option =
        data.type === ApplicationCommandType.ChatInput ? data.options?.find((o) => o.name === "agent") : undefined;
      const target = option && "value" in option ? String(option.value) : context.userId;
      const email = context.deps.settings.agentEmail(target);
      if (!email) throw new UserError("That Discord user is not linked to a Chatwoot agent.");
      return defer(context, { type: "assign", email });
    }
    default:
      return privately("Unknown command.");
  }
}

function submit(context: Context, interaction: APIModalSubmitInteraction): HandlerResult {
  const kind = interaction.data.custom_id.split(":", 1)[0];
  if (kind !== "reply" && kind !== "note") throw new UserError("Unknown form.");

  const components: unknown = interaction.data.components;
  const content = stringField(findComponent(components, "content"), "value")?.trim() ?? "";
  const files = uploadedFiles(interaction, components);
  if (content === "" && files.length === 0) throw new UserError("Add a message or an attachment.");
  checkFiles(files, context.deps.settings);

  return defer(context, { type: "message", private: kind === "note", content, files });
}

/** Files from the editor's upload field, as Discord describes them in the resolved data. */
function uploadedFiles(interaction: APIModalSubmitInteraction, components: unknown): AttachmentRef[] {
  const values = findComponent(components, "files")?.values;
  const ids = Array.isArray(values) ? values.map(String) : [];
  const resolved: Partial<Record<string, APIAttachment>> = interaction.data.resolved?.attachments ?? {};
  return ids.flatMap((id) => {
    const file = resolved[id];
    return file
      ? [
          {
            url: file.url,
            filename: file.filename,
            size: file.size,
            ...(file.content_type ? { contentType: file.content_type } : {}),
          },
        ]
      : [];
  });
}

function checkFiles(files: AttachmentRef[], settings: Settings): void {
  const limits = settings.config.attachments;
  if (files.length > limits.maxFiles) throw new UserError(`Attach at most ${limits.maxFiles} files.`);
  if (files.some((file) => file.size > limits.maxFileBytes)) {
    throw new UserError(`Each attachment must be ${megabytes(limits.maxFileBytes)} MB or smaller.`);
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalBytes) {
    throw new UserError(`Attachments must add up to ${megabytes(limits.maxTotalBytes)} MB or less.`);
  }
  if (!files.every((file) => isDiscordAttachmentUrl(file.url))) {
    throw new UserError("Attachments must be uploaded in Discord.");
  }
}

export function isDiscordAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ATTACHMENT_HOSTS.has(url.hostname) && url.port === "";
  } catch {
    return false;
  }
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

function replyWithThis(context: Context, interaction: APIApplicationCommandInteraction): HandlerResult {
  const draft = draftOf(context, interaction);
  if (draft === undefined || draft === "") {
    return privately("That message has no draft. Right-click the triage bot message that contains the draft.");
  }
  return { response: editor(context, "reply", draft) };
}

/**
 * A message command carries its target message, content included. From the triage bot, only the
 * code block after a draft label counts (its progress messages also contain code blocks); from
 * anyone else, the last code block, or the whole message when there is none.
 */
function draftOf(context: Context, interaction: APIApplicationCommandInteraction): string | undefined {
  const { data } = interaction;
  if (data.type !== ApplicationCommandType.Message) return undefined;
  const message = data.resolved.messages[data.target_id];
  const content = message?.content ?? "";
  const triage = context.deps.settings.config.triage;
  if (triage.userId && message?.author.id === triage.userId) return draftFromTriage(content, triage.draftLabels);
  return draftFromMessage(content);
}

/**
 * Modal with a text field and an optional upload field. Every editor gets ids unique to its
 * interaction: Discord keeps unsubmitted modal input per custom_id and would otherwise show text
 * from an earlier, cancelled editor instead of this draft.
 */
function editor(context: Context, kind: "reply" | "note", value: string | undefined): APIModalInteractionResponse {
  const nonce = context.interaction.id;
  const maxFiles = context.deps.settings.config.attachments.maxFiles;
  const label = kind === "note" ? "Private note" : "Message to the customer";
  const title = `${kind === "note" ? "Note" : "Reply"} · ${context.title}`;
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: `${kind}:${nonce}`,
      title: Array.from(title).slice(0, 45).join(""),
      components: [
        {
          type: ComponentType.Label,
          label,
          component: {
            type: ComponentType.TextInput,
            custom_id: `content:${nonce}`,
            style: TextInputStyle.Paragraph,
            required: false,
            max_length: CONTENT_MAX,
            ...(value ? { value: value.slice(0, CONTENT_MAX) } : {}),
          },
        },
        ...(maxFiles > 0
          ? [
              {
                type: ComponentType.Label as const,
                label: "Attachments",
                description: "Optional: images or files",
                component: {
                  type: ComponentType.FileUpload as const,
                  custom_id: `files:${nonce}`,
                  min_values: 0,
                  max_values: maxFiles,
                  required: false,
                },
              },
            ]
          : []),
      ],
    },
  };
}

function defer(context: Context, action: CommandAction): HandlerResult {
  const { interaction } = context;
  return {
    response: {
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    },
    job: {
      interactionId: interaction.id,
      applicationId: interaction.application_id,
      token: interaction.token,
      discordUserId: context.userId,
      accountId: context.ticket.accountId,
      conversationId: context.ticket.conversationId,
      ticketTitle: context.title,
      action,
    },
  };
}

export function privately(content: string): HandlerResult {
  return {
    response: {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
    },
  };
}

function invokerId(interaction: APIInteraction): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null;
}

function stringField(node: Node | undefined, key: string): string | undefined {
  const value = node?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Modal submissions nest inputs in labels (or legacy action rows); finds one by custom_id
 * ("content" matches "content:<nonce>").
 */
function findComponent(components: unknown, customId: string): Node | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const component of components) {
    if (!isNode(component)) continue;
    const id = stringField(component, "custom_id") ?? "";
    if (id === customId || id.startsWith(`${customId}:`)) return component;
    const children = Array.isArray(component.components) ? component.components : [component.component];
    const found = findComponent(children, customId);
    if (found) return found;
  }
  return undefined;
}
