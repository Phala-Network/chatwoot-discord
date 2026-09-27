// Worker entry: verifies and acknowledges Chatwoot webhooks and Discord interactions, and hands
// all slow work to the Hub Durable Object. Each request stays within a few milliseconds of CPU.

import type { APIInteraction } from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eventTarget, isFreshTimestamp, verifyChatwootSignature } from "./chatwoot/webhook.ts";
import { FAILED } from "./commands/common.ts";
import { handleInteraction, privately } from "./commands/handler.ts";
import { ConfigError, loadSettings } from "./config.ts";
import { HUB_NAME } from "./hub.ts";
import { errorFields, log } from "./log.ts";

const app = new Hono<{ Bindings: Env }>();

function hub(env: Env) {
  return env.HUB.getByName(HUB_NAME);
}

app.get("/healthz", (c) => {
  try {
    loadSettings(c.env);
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof ConfigError) log.error("configuration invalid", errorFields(error));
    return c.json({ ok: false }, 503);
  }
});

app.post("/chatwoot/webhook", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
  const settings = loadSettings(c.env);
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

  const stub = hub(c.env);
  if (target.type === "message-updated") {
    await stub.enqueueMessageUpdate(target.accountId, target.conversationId, target.messageId);
  } else {
    await stub.enqueueConversation(target.accountId, target.conversationId, target.delayMs);
  }
  return c.json({ ok: true });
});

app.post("/discord/interactions", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
  const settings = loadSettings(c.env);
  const signature = c.req.header("x-signature-ed25519");
  const timestamp = c.req.header("x-signature-timestamp");
  const body = await c.req.arrayBuffer();
  if (!signature || !timestamp || !(await verifyKey(body, signature, timestamp, settings.secrets.DISCORD_PUBLIC_KEY))) {
    return c.text("invalid request signature", 401);
  }

  let interaction: APIInteraction;
  try {
    // Discord signed this body, so it is a well-formed interaction (typed, not validated).
    interaction = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.text("bad request", 400);
  }

  const stub = hub(c.env);
  try {
    const result = await handleInteraction(interaction, {
      settings,
      ticketForThread: async (threadId) => (await stub.ticketForThread(threadId)) ?? undefined,
    });
    if (result.job) await stub.enqueueCommand(result.job);
    return c.json(result.response);
  } catch (error) {
    log.error("interaction failed", { interactionId: interaction.id, ...errorFields(error) });
    return c.json(privately(FAILED).response);
  }
});

app.notFound((c) => c.text("not found", 404));

app.onError((error, c) => {
  log.error("request failed", { path: c.req.path, ...errorFields(error) });
  return c.text("internal error", 500);
});

const handler = {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(hub(env).requestSweep());
  },
} satisfies ExportedHandler<Env>;

export default handler;

export { Hub } from "./hub.ts";
