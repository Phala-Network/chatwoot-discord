import { z } from "zod";

export const jsonRecord = z
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

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

export const reconcileSchema = z
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
  .prefault({});
