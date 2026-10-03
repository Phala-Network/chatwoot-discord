// Worker entry: verifies and acknowledges Chatwoot webhooks and Discord interactions, and hands
// slow work to the conversation Durable Object. Each request stays within a few milliseconds of CPU.

import { type APIInteraction, InteractionResponseType, InteractionType, MessageFlags } from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { within } from "../../../shared/deadline.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { eventTarget, isFreshTimestamp, verifyChatwootSignature } from "./chatwoot/webhook.ts";
import { CONTENT_MAX } from "./commands/definitions.ts";
import { ConfigError } from "./config.ts";
import { control, conversation } from "./control.ts";
import type { Env } from "./env.ts";
import { loadSettings } from "./settings.ts";

const INTERACTION_DEADLINE_MS = 2500;

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", async (c) => {
  try {
    await loadSettings(c.env);
    return c.json({ ok: true });
  } catch (error) {
    log.error(error instanceof ConfigError ? "configuration invalid" : "configuration unavailable", errorFields(error));
    return c.json({ ok: false }, 503);
  }
});

app.post("/chatwoot/webhook", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
  const settings = await loadSettings(c.env);
  const timestamp = c.req.header("x-chatwoot-timestamp");
  if (!timestamp || !isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
    return c.text("invalid or stale timestamp", 401);
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  const signature = c.req.header("x-chatwoot-signature");

  // The secret that verifies the request identifies the account it came from.
  let signedBy: number | undefined;
  for (const [accountId, secret] of Object.entries(settings.secrets.CHATWOOT_WEBHOOK_SECRETS)) {
    if (await verifyChatwootSignature(secret, timestamp, body, signature)) {
      signedBy = Number(accountId);
      break;
    }
  }
  if (signedBy === undefined) return c.text("invalid signature", 401);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.text("bad request", 400);
  }
  const target = eventTarget(payload);
  if (!target) return c.json({ ok: true, ignored: true });
  if (target.accountId !== signedBy || !settings.account(target.accountId)) {
    return c.text("account does not match the webhook secret", 403);
  }

  const stub = conversation(c.env, target.accountId, target.conversationId);
  if (target.type === "message-updated") {
    await control(undefined, () =>
      stub.enqueueMessageUpdate(target.accountId, target.conversationId, target.messageId),
    );
  } else {
    await control(undefined, () => stub.enqueueConversation(target.accountId, target.conversationId, target.delayMs));
  }
  return c.json({ ok: true });
});

// The triage bot's hook, signed like Chatwoot's webhooks: its answer `answerId` to message
// `replyTo` is in the post `threadId`, with the reply `draft` it proposes (see Conversation.triageAnswered).
const answerSchema = z.strictObject({
  threadId: z.string().regex(/^\d{17,20}$/),
  answerId: z.string().regex(/^\d{17,20}$/),
  replyTo: z.string().regex(/^\d{17,20}$/),
  draft: z.string().trim().min(1).max(CONTENT_MAX),
});

app.post("/triage/answered", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const secret = (await loadSettings(c.env)).secrets.TRIAGE_HOOK_SECRET;
  if (!secret) return c.text("not found", 404);
  const timestamp = c.req.header("x-timestamp");
  if (!timestamp || !isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
    return c.text("invalid or stale timestamp", 401);
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (!(await verifyChatwootSignature(secret, timestamp, body, c.req.header("x-signature")))) {
    return c.text("invalid signature", 401);
  }
  let answer: z.infer<typeof answerSchema>;
  try {
    answer = answerSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return c.text("bad request", 400);
  }
  const owner = await control(undefined, () => c.env.THREAD_DIRECTORY.getByName(`thread:v1:${answer.threadId}`).get());
  if (!owner || !(await loadSettings(c.env)).account(owner.accountId)) return c.text("unknown thread", 404);
  await control(undefined, () =>
    conversation(c.env, owner.accountId, owner.conversationId).triageAnswered(
      answer.threadId,
      answer.answerId,
      answer.replyTo,
      answer.draft,
    ),
  );
  return c.json({ ok: true });
});

app.post("/discord/interactions", async (c) => {
  const deadline = AbortSignal.timeout(INTERACTION_DEADLINE_MS);
  try {
    const response = await within(
      (async () => {
        const settings = await loadSettings(c.env);
        const signature = c.req.header("x-signature-ed25519");
        const timestamp = c.req.header("x-signature-timestamp");
        const body = await interactionBody(c.req.raw, deadline);
        if (!body) return c.text("payload too large", 413);
        if (
          !signature ||
          !timestamp ||
          !(await verifyKey(body, signature, timestamp, settings.secrets.DISCORD_PUBLIC_KEY))
        )
          return c.text("invalid request signature", 401);
        if (!isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) return c.text("stale request", 401);
        let interaction: APIInteraction;
        try {
          interaction = JSON.parse(new TextDecoder().decode(body));
        } catch {
          return c.text("bad request", 400);
        }
        deadline.throwIfAborted();
        if (interaction.type === InteractionType.Ping) return c.json({ type: InteractionResponseType.Pong });
        const refuse = (content: string) =>
          c.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { flags: MessageFlags.Ephemeral, content },
          });
        if (settings.config.cutover?.phase === "maintenance")
          return refuse(
            "Relay maintenance: this command was not accepted or executed. Please try again after maintenance.",
          );
        if (settings.config.cutover && BigInt(interaction.id) <= BigInt(settings.config.cutover.interactionFence))
          return refuse("This interaction belongs to the previous relay. Please reopen the command or editor.");
        const threadId = interaction.channel?.id ?? interaction.channel_id;
        if (!threadId) return refuse("Use this command inside a ticket post in the Chatwoot forum.");
        const owner = await control(undefined, () => c.env.THREAD_DIRECTORY.getByName(`thread:v1:${threadId}`).get());
        if (
          !owner ||
          settings.account(owner.accountId)?.forumChannelId !== owner.forumId ||
          interaction.guild_id !== owner.guildId
        )
          return refuse("Use this command inside a ticket post in the Chatwoot forum.");
        return c.json(await conversation(c.env, owner.accountId, owner.conversationId).interaction(interaction, owner));
      })(),
      deadline,
    );
    return response;
  } catch (error) {
    log.error("interaction initial response failed", errorFields(error));
    return c.text("The request could not be confirmed in time. Check in Chatwoot before trying again.", 503);
  }
});

app.notFound((c) => c.text("not found", 404));

app.onError((error, c) => {
  log.error("request failed", { path: c.req.path, ...errorFields(error) });
  return c.text("internal error", 500);
});

const handler = {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const settings = await loadSettings(env);
    if (settings.config.cutover?.phase === "maintenance") return;
    for (const account of settings.config.accounts)
      ctx.waitUntil(
        control(undefined, () => env.ACCOUNT_SWEEP.getByName(`account:v1:${account.id}`).request(account.id)),
      );
    for (const forumId of new Set(settings.config.accounts.map((account) => account.forumChannelId)))
      ctx.waitUntil(control(undefined, () => env.FORUM_REGISTRY.getByName(`forum:v1:${forumId}`).lookup(forumId)));
    const queue = settings.config.queue;
    if (
      queue &&
      new Date(controller.scheduledTime).getUTCMinutes() === 0 &&
      controller.scheduledTime >= (settings.config.cutover?.notificationsAfter ?? 0)
    )
      ctx.waitUntil(
        control(undefined, () =>
          env.QUEUE_DIGEST.getByName(`digest:v1:${queue.channelId}`).request(controller.scheduledTime),
        ),
      );
  },
} satisfies ExportedHandler<Env>;

export default handler;

export { DiscordRateLimit, ThreadDirectory, TriageBudget } from "./control.ts";
export { Conversation } from "./conversation.ts";
export { QueueDigest } from "./digest.ts";
export { Hub } from "./hub.ts";
export { ForumRegistry } from "./registry.ts";
export { AccountSweep } from "./sweep.ts";

async function interactionBody(request: Request, signal: AbortSignal): Promise<ArrayBuffer | undefined> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await within(reader.read(), signal);
      if (done) return await new Blob(chunks).arrayBuffer();
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
