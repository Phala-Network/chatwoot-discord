// Reads the Worker's settings once per isolate: the configuration from the `CONFIG` var (cloudflare.config.ts)
// or, past the 5 KB a var holds, from the CONFIG_STORE KV namespace under the key in the `CONFIG_KEY`
// var (see scripts/store-config.ts); and the Worker secrets.

import { ConfigError, parseSettings, type Settings } from "./config.ts";
import type { Env } from "./env.ts";
import { parseJson } from "./json.ts";

const cache = new WeakMap<object, Promise<Settings>>();

/** The validated settings; rejects with ConfigError with the offending paths (never values). */
export function loadSettings(env: Env): Promise<Settings> {
  let settings = cache.get(env);
  if (!settings) {
    settings = readSettings(env);
    cache.set(env, settings);
    // Not kept when it fails, so the next request reads them again.
    settings.catch(() => cache.delete(env));
  }
  return settings;
}

async function readSettings(env: Env): Promise<Settings> {
  return parseSettings(await readConfig(env), {
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
    CHATWOOT_RELAY_TOKEN: env.CHATWOOT_RELAY_TOKEN,
    CHATWOOT_WEBHOOK_SECRETS: env.CHATWOOT_WEBHOOK_SECRETS,
    CHATWOOT_AGENT_TOKENS: env.CHATWOOT_AGENT_TOKENS,
    CHATWOOT_BOT_TOKENS: env.CHATWOOT_BOT_TOKENS,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
    TRIAGE_HOOK_SECRET: env.TRIAGE_HOOK_SECRET,
  });
}

async function readConfig(env: Env): Promise<unknown> {
  if (env.CONFIG_KEY === undefined) return typeof env.CONFIG === "string" ? parseJson(env.CONFIG) : env.CONFIG;
  if (env.CONFIG !== undefined) throw new ConfigError("Invalid CONFIG: set either CONFIG or CONFIG_KEY");
  if (!env.CONFIG_STORE) throw new ConfigError("Invalid CONFIG_KEY: requires the CONFIG_STORE KV namespace");
  // A key names one configuration and is never rewritten, so whichever copy KV returns is current.
  const config = await env.CONFIG_STORE.get(env.CONFIG_KEY, "json");
  if (config === null) throw new ConfigError("Invalid CONFIG_KEY: not in CONFIG_STORE");
  return config;
}
