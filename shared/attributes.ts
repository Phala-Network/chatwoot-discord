export const ROUTING_ATTRIBUTES = {
  seen: "routing_seen",
  handled: "routing_handled",
  kind: "routing_kind",
} as const;

export function messageWatermark(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
