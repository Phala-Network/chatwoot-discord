/** A persisted hook draft, or the reason the editor cannot be prefilled. */
export type Draft = { text: string } | { missing: "none" } | { missing: "unreadable" };
