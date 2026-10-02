import { z } from "zod";
import { ConfigError, describe, jsonRecord } from "../../../shared/config.ts";

export { ConfigError } from "../../../shared/config.ts";

const accountId = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a Chatwoot account id")
  .refine((value) => Number.isSafeInteger(Number(value)), "must be a safe integer");

export const configSchema = z
  .strictObject({
    chatwoot: z.strictObject({ baseUrl: z.url({ protocol: /^https?$/ }) }),
    subrequestBudget: z.number().int().min(45).max(1000).default(45),
    routing: z.strictObject({
      model: z.string().min(1).default("jev-1.13.0"),
      /** Jev's probability an answer needs before it is applied. */
      minConfidence: z.number().min(0.5).max(1).default(0.7),
      /** The account's native Chatwoot agent bot. */
      botIds: z.record(accountId, z.number().int().positive()),
      /** Per Chatwoot account id: the owners Jev chooses from, by a short name. */
      accounts: z.record(
        accountId,
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
          accountId,
          z.record(
            z
              .string()
              .regex(/^[a-z0-9_-]{1,40}$/, "must be a short lower-case name")
              .refine((name) => name !== "none", "none is reserved"),
            z.strictObject({
              /** What the kind is, as Jev's criterion for recognizing it. */
              covers: z.string().min(1).max(1000),
              /**
               * Short code of the account's Chatwoot canned response sent to the customer once, as
               * the account's agent bot (CHATWOOT_AGENT_BOT_TOKENS). Missing responses hand off to people.
               */
              cannedResponse: z.string().trim().min(1).max(255).optional(),
              /**
               * Set instead of routing the ticket (after the reply, with cannedResponse): `resolved`,
               * or `snoozed` until the customer's next message. A new message from the customer
               * reopens either.
               */
              status: z.enum(["resolved", "snoozed"]).optional(),
            }),
          ),
        )
        .optional(),
    }),
  })
  .refine(
    (config) => {
      const accounts = Object.keys(config.routing.accounts);
      return (
        accounts.length > 0 &&
        accounts.length === Object.keys(config.routing.botIds).length &&
        accounts.every((id) => config.routing.botIds[id] !== undefined)
      );
    },
    { path: ["routing", "botIds"], message: "must name exactly the routed accounts" },
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
export const secretsSchema = z.object({
  CHATWOOT_TOKEN: z.string().min(1),
  CHATWOOT_AGENT_BOT_SECRETS: jsonRecord,
  TYPESAFE_API_KEY: z.string().min(1),
  CHATWOOT_AGENT_BOT_TOKENS: jsonRecord,
});

type Config = z.infer<typeof configSchema>;
type Secrets = z.infer<typeof secretsSchema>;

export interface Settings {
  config: Config;
  secrets: Secrets;
  botToken(accountId: number): string | undefined;
}

export function parseSettings(rawConfig: unknown, rawSecrets: object): Settings {
  const config = configSchema.safeParse(rawConfig);
  if (!config.success) throw new ConfigError(`Invalid CONFIG: ${describe(config.error)}`);
  const secrets = secretsSchema.safeParse(rawSecrets);
  if (!secrets.success) throw new ConfigError(`Invalid secrets: ${describe(secrets.error)}`);
  return buildSettings(config.data, secrets.data);
}

export function buildSettings(config: Config, secrets: Secrets): Settings {
  const accounts = Object.keys(config.routing.accounts);
  for (const name of ["CHATWOOT_AGENT_BOT_SECRETS", "CHATWOOT_AGENT_BOT_TOKENS"] as const) {
    if (Object.keys(secrets[name]).length !== accounts.length || accounts.some((id) => !secrets[name][id]?.trim())) {
      throw new ConfigError(`Invalid secrets: ${name}: needs exactly the routed accounts`);
    }
  }
  return { config, secrets, botToken: (accountId) => secrets.CHATWOOT_AGENT_BOT_TOKENS[String(accountId)] };
}
