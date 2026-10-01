// Configuration: non-secret settings come from the `CONFIG` var (wrangler.jsonc), secrets from
// Worker secrets. Both are validated once per isolate.

import { z } from "zod";
import { parseJson } from "./json.ts";
import { queueBudget } from "./queue-limits.ts";
import { minimumBudget } from "./relay/limits.ts";

/** Gravatar's built-in "mp" default image, forced (it does not depend on any email). */
const DEFAULT_CONTACT_AVATAR = "https://gravatar.com/avatar/?d=mp&f=y&s=256";

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake id");
/** What a forum tag stands for (see tagKeys in relay/format.ts). */
const tagKey = z
  .string()
  .regex(
    /^(account:\d+|status:(open|pending|snoozed|resolved)|assignee:(none|\d+)|priority:(urgent|high|medium|low)|topic:.+|label:.+)$/,
    "must be account:<id>, status:<status>, assignee:<Chatwoot user id or none>, priority:<priority>, topic:<value>, or label:<label>",
  );
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const MB = 1024 * 1024;

export const configSchema = z
  .strictObject({
    chatwoot: z.strictObject({
      /** Base URL for Chatwoot's REST API, e.g. https://chatwoot.example.com */
      baseUrl: z.url({ protocol: /^https?$/ }),
      /** Base URL for dashboard links in Discord. Defaults to baseUrl. */
      publicUrl: z.url({ protocol: /^https?$/ }).optional(),
      /**
       * The Chatwoot build sends an email reply with `content_attributes.send_as_agent` from the
       * agent's own address (Phala-Network/chatwoot); the reply editor then offers it.
       */
      sendAsAgent: z.boolean().default(false),
    }),
    accounts: z
      .array(
        z.strictObject({
          id: z.number().int().positive(),
          /** Shown in post titles ("[Name #12] ...") and command confirmations. */
          name: z.string().min(1),
          forumChannelId: snowflake,
          /** Relay only conversations of these inboxes. Unset: every inbox. */
          inboxIds: z.array(z.number().int().positive()).min(1).optional(),
        }),
      )
      .min(1)
      .refine((accounts) => unique(accounts.map((account) => account.id)), {
        message: "account ids must be unique",
      }),
    agents: z
      .array(
        z.strictObject({
          discordUserId: snowflake,
          /** The Chatwoot agent's user id, which (unlike their email) they cannot change. */
          chatwootUserId: z.number().int().positive(),
        }),
      )
      .refine((agents) => unique(agents.map((agent) => agent.discordUserId)), {
        message: "discordUserId must be unique",
      })
      .refine((agents) => unique(agents.map((agent) => agent.chatwootUserId)), {
        message: "chatwootUserId must be unique",
      })
      .default([]),
    /** Per forum channel id: forum tag id by what it stands for ("status:open": "<tag id>"). */
    forumTags: z.record(snowflake, z.record(tagKey, snowflake)).default({}),
    triage: z
      .strictObject({
        /** Discord user id of a triage bot to mention on customer messages. Unset: no mention. */
        userId: snowflake.optional(),
        /** Shown in budget notes; bounded so a message's notification lines always fit. */
        name: z.string().min(1).max(100).default("Triage bot"),
        perConversationPerHour: z.number().int().positive().default(5),
        perHour: z.number().int().positive().default(30),
      })
      .prefault({}),
    relay: z
      .strictObject({
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
    avatars: z
      .strictObject({
        /** Avatar of messages from Chatwoot (agents, notes, activity). Default: the instance's own icon. */
        chatwoot: z.url({ protocol: /^https$/ }).optional(),
        /** Avatar of customers who have none in Chatwoot. Default: Gravatar's "mystery person" image. */
        contact: z.url({ protocol: /^https$/ }).default(DEFAULT_CONTACT_AVATAR),
      })
      .prefault({}),
    reconcile: z
      .strictObject({
        /** The sweep looks at conversations with activity within at least this window. */
        lookbackSeconds: z.number().int().min(60).default(3600),
        /** After downtime, the sweep catches up at most this far back. */
        maxCatchUpSeconds: z
          .number()
          .int()
          .min(60)
          .default(7 * 24 * 3600),
      })
      .prefault({}),
    /**
     * Assigns new tickets and sets their topic with TypeSafe Jev (see src/routing.ts). Unset: off.
     * Needs the TYPESAFE_API_KEY secret.
     */
    routing: z
      .strictObject({
        model: z.string().min(1).default("jev-1.13.0"),
        /** Jev's probability an answer needs before it is applied. */
        minConfidence: z.number().min(0.5).max(1).default(0.7),
        /** Snooze a ticket Jev cannot assign yet until the customer's next message (see src/routing.ts). */
        snoozeUnclear: z.boolean().default(false),
        /** Per Chatwoot account id: the owners Jev chooses from, by a short name. */
        accounts: z.record(
          z.string().regex(/^\d+$/, "must be a Chatwoot account id"),
          z
            .record(
              z
                .string()
                .regex(/^[a-z0-9_]{1,40}$/, "must be a short lower-case name")
                .refine((name) => name !== "unclear", "unclear is reserved"),
              z.strictObject({
                /** Chatwoot user id to assign. */
                assignee: z.number().int().positive(),
                /** What the owner handles, as Jev's criterion for choosing them. */
                covers: z.string().min(1).max(1000),
              }),
            )
            .refine((owners) => Object.keys(owners).length > 0, "needs at least one owner"),
        ),
        /** Topic labels (Chatwoot label names, lower case) and what each covers. Unset: no topic. */
        topics: z
          .record(
            z.string().regex(/^[a-z0-9_-]{1,255}$/, "must be a Chatwoot label name (lower case)"),
            z.string().min(1).max(1000),
          )
          .optional(),
        /**
         * Per Chatwoot account id: kinds of ticket Jev recognizes, by a short name, and what is done,
         * once, when it does (see src/routing.ts). Unset: none.
         */
        kinds: z
          .record(
            z.string().regex(/^\d+$/, "must be a Chatwoot account id"),
            z.record(
              z
                .string()
                .regex(/^[a-z0-9_-]{1,40}$/, "must be a short lower-case name")
                .refine((name) => name !== "none", "none is reserved"),
              z
                .strictObject({
                  /** What the kind is, as Jev's criterion for recognizing it. */
                  covers: z.string().min(1).max(1000),
                  /** Sent to the customer once, as the account's agent bot (CHATWOOT_BOT_TOKENS). */
                  reply: z.string().trim().min(1).max(4000).optional(),
                  /**
                   * Set instead of routing the ticket: `resolved`, or `snoozed` until the customer's
                   * next message. A new message from the customer reopens either.
                   */
                  status: z.enum(["resolved", "snoozed"]).optional(),
                })
                .refine((kind) => !(kind.status && kind.reply), "a ticket set aside gets no reply"),
            ),
          )
          .optional(),
      })
      .optional(),
    /**
     * The hourly support queue (see src/queue.ts). Unset: off. The cron trigger must fire at minute 0.
     */
    queue: z
      .strictObject({
        /** Discord channel or forum post the queue is posted in. */
        channelId: snowflake,
        /** Role or user pinged when an unassigned ticket's customer has waited long (see src/queue.ts). Unset: none. */
        escalationRoleId: snowflake.optional(),
        escalationUserId: snowflake.optional(),
      })
      .refine((queue) => !(queue.escalationRoleId && queue.escalationUserId), {
        message: "set escalationRoleId or escalationUserId, not both",
      })
      .optional(),
    attachments: z
      .strictObject({
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
  })
  .refine((config) => config.relay.subrequestBudget >= minimumBudget(config.relay.maxChunks), {
    path: ["relay", "subrequestBudget"],
    message: "must fit a run's setup and one message of relay.maxChunks parts (see src/relay/limits.ts)",
  })
  .refine((config) => !config.queue || config.relay.subrequestBudget >= queueBudget(config.accounts.length), {
    path: ["relay", "subrequestBudget"],
    message: "must fit the support queue's pages and messages (see src/queue.ts)",
  })
  .refine(
    (config) =>
      Object.keys(config.routing?.accounts ?? {}).every((id) =>
        config.accounts.some((account) => account.id === Number(id)),
      ),
    { path: ["routing", "accounts"], message: "must only name configured accounts" },
  )
  .refine((config) => Object.keys(config.routing?.kinds ?? {}).every((id) => config.routing?.accounts[id]), {
    path: ["routing", "kinds"],
    message: "must only name routed accounts",
  })
  .refine(
    (config) =>
      Object.values(config.routing?.kinds ?? {}).every((kinds) =>
        Object.keys(kinds).every((kind) => !Object.hasOwn(config.routing?.topics ?? {}, kind)),
      ),
    { path: ["routing", "kinds"], message: "a kind cannot be named as a topic: they are labels of two families" },
  );

type Config = z.infer<typeof configSchema>;
type AccountConfig = Config["accounts"][number];
type AgentConfig = Config["agents"][number];

/** Whether conversations of `inboxId` are relayed for the account (see `inboxIds`). */
export function relaysInbox(account: AccountConfig, inboxId: number | undefined): boolean {
  return !account.inboxIds || (inboxId !== undefined && account.inboxIds.includes(inboxId));
}

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
  /**
   * JSON: {"<account id>": "<access token of that account's Chatwoot agent bot>"}: the bot that sends
   * routing kinds' replies, under its own name (e.g. "Acme Support"); required for an account whose
   * kinds reply.
   */
  CHATWOOT_BOT_TOKENS: jsonRecord.default({}),
  /** TypeSafe API key; required when `routing` is configured. */
  TYPESAFE_API_KEY: z.string().min(1).optional(),
  /** Shared with the triage bot's hook, which signs POST /triage/answered. Unset: the route is off. */
  TRIAGE_HOOK_SECRET: z.string().min(32).optional(),
});

type Secrets = z.infer<typeof secretsSchema>;

export interface Settings {
  config: Config;
  secrets: Secrets;
  frontendUrl: string;
  avatars: { chatwoot: string; contact: string };
  account(id: number): AccountConfig | undefined;
  /** Discord user id -> the linked agent's Chatwoot user id. */
  chatwootUserFor(discordUserId: string): number | undefined;
  /** Chatwoot user id -> the linked agent. */
  linkedAgent(chatwootUserId: number | null | undefined): AgentConfig | undefined;
  agentToken(discordUserId: string): string | undefined;
  /** The account's Chatwoot agent bot token (see CHATWOOT_BOT_TOKENS). */
  botToken(accountId: number): string | undefined;
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

  const rawConfig: unknown = typeof env.CONFIG === "string" ? parseJson(env.CONFIG) : env.CONFIG;
  const config = configSchema.safeParse(rawConfig);
  if (!config.success) throw new ConfigError(`Invalid CONFIG: ${describe(config.error)}`);
  const secrets = secretsSchema.safeParse({
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
    CHATWOOT_RELAY_TOKEN: env.CHATWOOT_RELAY_TOKEN,
    CHATWOOT_WEBHOOK_SECRETS: env.CHATWOOT_WEBHOOK_SECRETS,
    CHATWOOT_AGENT_TOKENS: env.CHATWOOT_AGENT_TOKENS,
    CHATWOOT_BOT_TOKENS: env.CHATWOOT_BOT_TOKENS,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
    TRIAGE_HOOK_SECRET: env.TRIAGE_HOOK_SECRET,
  });
  if (!secrets.success) throw new ConfigError(`Invalid secrets: ${describe(secrets.error)}`);

  const settings = buildSettings(config.data, secrets.data);
  cache.set(env, settings);
  return settings;
}

export function buildSettings(config: Config, secrets: Secrets): Settings {
  if (config.routing && !secrets.TYPESAFE_API_KEY) {
    throw new ConfigError("Invalid secrets: TYPESAFE_API_KEY: required when routing is configured");
  }
  for (const [accountId, kinds] of Object.entries(config.routing?.kinds ?? {})) {
    if (Object.values(kinds).some((kind) => kind.reply) && !secrets.CHATWOOT_BOT_TOKENS[accountId]) {
      throw new ConfigError(`Invalid secrets: CHATWOOT_BOT_TOKENS: account ${accountId} has kinds that reply`);
    }
  }
  const accounts = new Map(config.accounts.map((account) => [account.id, account]));
  const chatwootUsers = new Map(config.agents.map((agent) => [agent.discordUserId, agent.chatwootUserId]));
  const linkedAgents = new Map(config.agents.map((agent) => [agent.chatwootUserId, agent]));
  const frontendUrl = config.chatwoot.publicUrl ?? config.chatwoot.baseUrl;
  return {
    config,
    secrets,
    frontendUrl,
    avatars: {
      // Chatwoot serves its logo at /favicon-512x512.png (public/ in the Chatwoot repository).
      chatwoot: config.avatars.chatwoot ?? `${frontendUrl.replace(/\/+$/, "")}/favicon-512x512.png`,
      contact: config.avatars.contact,
    },
    account: (id) => accounts.get(id),
    chatwootUserFor: (discordUserId) => chatwootUsers.get(discordUserId),
    linkedAgent: (chatwootUserId) => (chatwootUserId == null ? undefined : linkedAgents.get(chatwootUserId)),
    agentToken: (discordUserId) => secrets.CHATWOOT_AGENT_TOKENS[discordUserId],
    botToken: (accountId) => secrets.CHATWOOT_BOT_TOKENS[String(accountId)],
  };
}

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
