// Structured JSON logs (collected by Workers Logs). Never pass message bodies, tokens, or
// secrets as fields: log ids and outcomes only.

import { captureException } from "@sentry/cloudflare";

type Fields = Record<string, string | number | boolean | null | undefined>;

function write(level: "info" | "warn" | "error", message: string, fields: Fields = {}): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
};

/** The error's class and message, safe to log: errors in this service never carry bodies. */
export function errorFields(error: unknown): Fields {
  return error instanceof Error ? { error: error.name, detail: error.message } : { error: String(error) };
}

/** Sends an error to Sentry when SENTRY_DSN is configured; otherwise a no-op. */
export function report(error: unknown): void {
  captureException(error);
}
