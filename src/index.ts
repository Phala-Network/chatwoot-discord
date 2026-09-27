// Worker entry: verifies and acknowledges Chatwoot webhooks and Discord interactions, and hands
// all slow work to the Hub Durable Object. Each request stays within a few milliseconds of CPU.

import { env as workerEnv } from "cloudflare:workers";
import { instrumentDurableObjectWithSentry, withSentry } from "@sentry/cloudflare";
import type { APIInteraction } from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { eventTarget, isFreshTimestamp, verifyChatwootSignature } from "./chatwoot/webhook.js";
import { FAILED, handleInteraction, privately } from "./commands/handler.js";
import { ConfigError, loadSettings } from "./config.js";
import { HUB_NAME, Hub as HubObject } from "./hub.js";
import { errorFields, log, report } from "./log.js";

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

  const result = await hub(c.env).enqueueConversation(
    target.accountId,
    target.conversationId,
    c.req.header("x-chatwoot-delivery") || undefined,
  );
  return c.json({ ok: true, duplicate: result === "duplicate" });
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
    // Discord signed this body, so it is a well-formed interaction.
    interaction = JSON.parse(new TextDecoder().decode(body)) as APIInteraction;
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
    report(error);
    return c.json(privately(FAILED).response);
  }
});

const importRow = z.object({
  accountId: z.number().int().positive(),
  conversationId: z.number().int().positive(),
  threadId: z.string().regex(/^\d{17,20}$/),
  lastMessageId: z.number().int().min(0).optional(),
});

/**
 * One-shot cutover import of conversation -> post mappings as JSON lines. Disabled unless
 * ADMIN_TOKEN is set; remove the secret after the import.
 */
app.post("/admin/import", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
  const settings = loadSettings(c.env);
  const expected = settings.secrets.ADMIN_TOKEN;
  if (!expected) return c.notFound();
  if (!(await sameSecret(c.req.header("authorization") ?? "", `Bearer ${expected}`))) {
    return c.text("unauthorized", 401);
  }

  const lines = (await c.req.text()).split("\n").filter((line) => line.trim() !== "");
  const rows = [];
  const invalid: number[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const row = importRow.safeParse(parsed);
    if (row.success) rows.push(row.data);
    else invalid.push(index + 1);
  }
  const result = await hub(c.env).importMappings(rows);
  return c.json({ ...result, invalidLines: invalid });
});

app.notFound((c) => c.text("not found", 404));

app.onError((error, c) => {
  log.error("request failed", { path: c.req.path, ...errorFields(error) });
  report(error);
  return c.text("internal error", 500);
});

/** Compares secrets in constant time (hashing first so lengths do not leak). */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const handler = {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(hub(env).requestSweep());
  },
} satisfies ExportedHandler<Env>;

// Sentry is only loaded into the request path when SENTRY_DSN is set.
const sentryOptions = (env: Env) => ({ dsn: env.SENTRY_DSN });
const withErrorReporting = withSentry(sentryOptions, handler);

export default {
  fetch: (request, env, ctx) =>
    env.SENTRY_DSN ? withErrorReporting.fetch(request, env, ctx) : handler.fetch(request, env, ctx),
  scheduled: (controller, env, ctx) =>
    env.SENTRY_DSN ? withErrorReporting.scheduled(controller, env, ctx) : handler.scheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;

export const Hub = workerEnv.SENTRY_DSN ? instrumentDurableObjectWithSentry(sentryOptions, HubObject) : HubObject;
