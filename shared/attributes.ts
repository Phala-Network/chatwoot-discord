import { z } from "zod";

export const attributesSchema = z
  .strictObject({
    seen: z.string().min(1).default("routing_seen"),
    handled: z.string().min(1).default("routing_handled"),
    kind: z.string().min(1).default("routing_kind"),
  })
  .refine((attributes) => new Set(Object.values(attributes)).size === 3, "attribute names must be distinct");

export function messageWatermark(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
