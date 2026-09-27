// Configuration: non-secret settings come from the `CONFIG` var (wrangler.jsonc), secrets from
// Worker secrets. Both are validated once per isolate.

import { z } from "zod";

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake id");
const MB = 1024 * 1024;

export const configSchema = z.object({
  chatwoot: z.object({
    /** Base URL for Chatwoot's REST API, e.g. https://chatwoot.example.com */
    baseUrl: z.url({ protocol: /^https?$/ }),
    /** Base URL for dashboard links in Discord. Defaults to baseUrl. */
    publicUrl: z.url({ protocol: /^https?$/ }).optional(),
  }),
  discord: z.object({
    applicationId: snowflake,
  }),
  accounts: z
    .array(
      z.object({
        id: z.number().int().positive(),
        /** Shown in post titles ("[Name #12] ...") and command confirmations. */
        name: z.string().min(1),
        forumChannelId: snowflake,
        /** Forum tag applied to the account's posts. Defaults to `name`. */
        tag: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .refine((accounts) => new Set(accounts.map((account) => account.id)).size === accounts.length, {
      message: "account ids must be unique",
    }),
  agents: z
    .array(
      z.object({
        discordUserId: snowflake,
        /** The Chatwoot agent's email. Used to ping assignees and to resolve /assign targets. */
        email: z.email(),
      }),
    )
    .default([]),
  triage: z
    .object({
      /** Discord user id of a triage bot to mention on customer messages. Unset: no mention. */
      userId: snowflake.optional(),
      name: z.string().min(1).default("Triage bot"),
      perConversationPerHour: z.number().int().positive().default(5),
      perHour: z.number().int().positive().default(30),
      /** Labels that introduce the triage bot's draft code block ("Reply with this"). */
      draftLabels: z.array(z.string().min(1)).min(1).default(["Draft"]),
    })
    .prefault({}),
  relay: z
    .object({
      /** A very long message is cut after this many Discord messages. */
      maxChunks: z.number().int().min(1).max(10).default(4),
      /** Conversation custom attribute used as a topic tag. */
      topicAttribute: z.string().min(1).default("topic"),
      /** Conversation custom attribute that receives the post URL (a Link attribute). Empty disables it. */
      linkAttribute: z.string().default("discord_thread"),
      /** Messages with an id at or below this are never relayed (cutover watermark). */
      startAfterMessageId: z.number().int().min(0).default(0),
      /** A message that fails this many times is skipped with a notice in its post. */
      maxAttempts: z.number().int().min(1).default(5),
      /** Outbound requests per Durable Object alarm run (the Workers Free limit is 50). */
      subrequestBudget: z.number().int().min(20).max(1000).default(45),
    })
    .prefault({}),
  reconcile: z
    .object({
      /** The sweep looks at conversations updated within at least this window. */
      lookbackSeconds: z.number().int().min(60).default(3600),
      /** After downtime, the sweep catches up at most this far back. */
      maxCatchUpSeconds: z
        .number()
        .int()
        .min(60)
        .default(7 * 24 * 3600),
    })
    .prefault({}),
  attachments: z
    .object({
      maxFiles: z.number().int().min(0).max(10).default(10),
      /** Per file. Files are held in memory (128 MB per isolate), so keep the total modest. */
      maxFileBytes: z
        .number()
        .int()
        .positive()
        .default(25 * MB),
      maxTotalBytes: z
        .number()
        .int()
        .positive()
        .max(80 * MB)
        .default(50 * MB),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type AccountConfig = Config["accounts"][number];

const jsonRecord = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a JSON object" });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string(), z.string().min(1)));

export const secretsSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "must be the hex Ed25519 public key"),
  /** Token of the Chatwoot user the relay reads as (an agent in every relayed inbox, or an admin). */
  CHATWOOT_RELAY_TOKEN: z.string().min(1),
  /** JSON: {"<account id>": "<account webhook secret>"} */
  CHATWOOT_WEBHOOK_SECRETS: jsonRecord,
  /** JSON: {"<Discord user id>": "<that agent's Chatwoot access token>"} */
  CHATWOOT_AGENT_TOKENS: jsonRecord.default({}),
  /** Enables POST /admin/import when set. */
  ADMIN_TOKEN: z.string().min(32).optional(),
  SENTRY_DSN: z.string().optional(),
});

export type Secrets = z.infer<typeof secretsSchema>;

export interface Settings {
  config: Config;
  secrets: Secrets;
  frontendUrl: string;
  account(id: number): AccountConfig | undefined;
  /** Discord user id -> agent email (lower-cased). */
  agentEmail(discordUserId: string): string | undefined;
  /** Agent email -> Discord user id. */
  discordUserForEmail(email: string | null | undefined): string | undefined;
  agentToken(discordUserId: string): string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const cache = new WeakMap<object, Settings>();

/** Parses and validates settings; throws ConfigError with the offending paths (never values). */
export function loadSettings(env: Env): Settings {
  const cached = cache.get(env);
  if (cached) return cached;

  const rawConfig: unknown = typeof env.CONFIG === "string" ? safeJson(env.CONFIG) : env.CONFIG;
  const config = configSchema.safeParse(rawConfig);
  if (!config.success) throw new ConfigError(`Invalid CONFIG: ${describe(config.error)}`);
  const secrets = secretsSchema.safeParse({
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
    CHATWOOT_RELAY_TOKEN: env.CHATWOOT_RELAY_TOKEN,
    CHATWOOT_WEBHOOK_SECRETS: env.CHATWOOT_WEBHOOK_SECRETS,
    CHATWOOT_AGENT_TOKENS: env.CHATWOOT_AGENT_TOKENS,
    ADMIN_TOKEN: env.ADMIN_TOKEN || undefined,
    SENTRY_DSN: env.SENTRY_DSN || undefined,
  });
  if (!secrets.success) throw new ConfigError(`Invalid secrets: ${describe(secrets.error)}`);

  const settings = buildSettings(config.data, secrets.data);
  cache.set(env, settings);
  return settings;
}

export function buildSettings(config: Config, secrets: Secrets): Settings {
  const accounts = new Map(config.accounts.map((account) => [account.id, account]));
  const emails = new Map(config.agents.map((agent) => [agent.discordUserId, agent.email.toLowerCase()]));
  const discordByEmail = new Map(config.agents.map((agent) => [agent.email.toLowerCase(), agent.discordUserId]));
  return {
    config,
    secrets,
    frontendUrl: config.chatwoot.publicUrl ?? config.chatwoot.baseUrl,
    account: (id) => accounts.get(id),
    agentEmail: (discordUserId) => emails.get(discordUserId),
    discordUserForEmail: (email) => (email ? discordByEmail.get(email.toLowerCase()) : undefined),
    agentToken: (discordUserId) => secrets.CHATWOOT_AGENT_TOKENS[discordUserId],
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
