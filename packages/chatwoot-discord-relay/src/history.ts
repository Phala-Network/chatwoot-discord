// Private receipt handover only. Titles are customer data: never log headers or pages.
import { z } from "zod";
import type { Store } from "./store.ts";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snowflake = z.string().regex(/^\d{17,20}$/);
const privateTitle = z
  .string()
  .max(4096)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const baselineLinkageSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("recorded") }),
  z.strictObject({
    state: z.literal("deleted-source"),
    evidenceRef: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9:._/-]+$/),
  }),
  z.strictObject({ state: z.literal("unresolved") }),
]);
export const receiptCountsSchema = z.strictObject({ posted: count, derived: count, responses: count });
export const receiptHeaderSchema = z.strictObject({
  sourceIdentity: z.string().min(1).max(256),
  schemaVersion: z.union([z.literal(9), z.literal(10)]),
  accountId: id,
  conversationId: id,
  threadId: snowflake,
  cursor: count,
  titleSubject: privateTitle.nullable(),
  title: privateTitle.nullable(),
  titleMessageId: id.nullable(),
  titleAssociation: z.enum(["absent", "recorded", "never-recorded-or-unresolved"]),
  counts: receiptCountsSchema,
});
export function validateTitleMetadata(header: ReceiptHeader): void {
  if (
    (header.titleSubject === null) !== (header.title === null) ||
    (header.titleMessageId !== null && header.titleSubject === null) ||
    (header.titleMessageId !== null && header.titleMessageId > header.cursor) ||
    header.titleAssociation !== titleAssociation(header)
  )
    throw new Error("Missing or inconsistent authoritative title association");
}
export function titleAssociation(header: {
  titleSubject: string | null;
  title: string | null;
  titleMessageId: number | null;
}): ReceiptHeader["titleAssociation"] {
  return header.titleMessageId !== null
    ? "recorded"
    : header.titleSubject !== null || header.title !== null
      ? "never-recorded-or-unresolved"
      : "absent";
}
export const receiptSealSchema = z.strictObject({ header: receiptHeaderSchema, pages: id, digest });
const positionSchema = z.strictObject({ kind: z.number().int().min(0).max(2), rowid: count });
export const recordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal(0), rowid: id, messageId: id, part: count, discordId: snowflake }),
  z.strictObject({ kind: z.literal(1), rowid: id, messageId: id, discordId: snowflake }),
  z.strictObject({ kind: z.literal(2), rowid: id, messageId: id, digest, linkage: baselineLinkageSchema }),
]);
export const receiptPageSchema = z.strictObject({
  header: receiptHeaderSchema,
  index: count,
  after: positionSchema,
  next: positionSchema,
  previous: digest,
  digest,
  records: z.array(recordSchema).max(100),
  complete: z.boolean(),
});
export type ReceiptHeader = z.infer<typeof receiptHeaderSchema>;
export type ReceiptSeal = z.infer<typeof receiptSealSchema>;
export type ReceiptPage = z.infer<typeof receiptPageSchema>;
export type ReceiptPosition = { index: number; after: ReceiptPage["after"]; previous: string };
export type ReceiptCounts = z.infer<typeof receiptCountsSchema>;
export const EMPTY_COUNTS: ReceiptCounts = { posted: 0, derived: 0, responses: 0 };

// Canonicalize field order even across RPC serialization or operator JSON reformatting.
export function canonicalHeader(header: ReceiptHeader): ReceiptHeader {
  return {
    sourceIdentity: header.sourceIdentity,
    schemaVersion: header.schemaVersion,
    accountId: header.accountId,
    conversationId: header.conversationId,
    threadId: header.threadId,
    cursor: header.cursor,
    titleSubject: header.titleSubject,
    title: header.title,
    titleMessageId: header.titleMessageId,
    titleAssociation: header.titleAssociation,
    counts: { posted: header.counts.posted, derived: header.counts.derived, responses: header.counts.responses },
  };
}
export function canonicalSeal(seal: ReceiptSeal): ReceiptSeal {
  return { header: canonicalHeader(seal.header), pages: seal.pages, digest: seal.digest };
}
export async function receiptHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function receiptPageBody(page: Omit<ReceiptPage, "digest">) {
  return {
    header: canonicalHeader(page.header),
    index: page.index,
    after: { kind: page.after.kind, rowid: page.after.rowid },
    next: { kind: page.next.kind, rowid: page.next.rowid },
    previous: page.previous,
    records: page.records.map((record) => {
      const base = { kind: record.kind, rowid: record.rowid, messageId: record.messageId };
      if (record.kind === 0) return { ...base, part: record.part, discordId: record.discordId };
      if (record.kind === 1) return { ...base, discordId: record.discordId };
      return {
        ...base,
        digest: record.digest,
        linkage:
          record.linkage.state === "deleted-source"
            ? { state: record.linkage.state, evidenceRef: record.linkage.evidenceRef }
            : { state: record.linkage.state },
      };
    }),
    complete: page.complete,
  };
}
export async function validateReceiptPage(input: ReceiptPage): Promise<ReceiptPage> {
  // Avoid Zod error payloads, which could include a private title.
  const parsed = receiptPageSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid legacy receipt page");
  const page = parsed.data;
  let last = page.after;
  for (const record of page.records) {
    if (
      record.kind < last.kind ||
      (record.kind === last.kind && record.rowid <= last.rowid) ||
      record.messageId > page.header.cursor
    )
      throw new Error("Legacy receipt order or cursor conflict");
    last = record;
  }
  if (last.kind !== page.next.kind || last.rowid !== page.next.rowid || (!page.complete && page.records.length !== 100))
    throw new Error("Incomplete legacy receipt page");
  validateTitleMetadata(page.header);
  if ((await receiptHash(receiptPageBody(page))) !== page.digest) throw new Error("Legacy receipt digest mismatch");
  return page;
}
export function nextReceiptPosition(page: ReceiptPage): ReceiptPosition {
  return { index: page.index + 1, after: page.next, previous: page.digest };
}
export function receiptSeal(page: ReceiptPage): ReceiptSeal {
  if (!page.complete) throw new Error("Legacy export is not complete");
  return canonicalSeal({ header: page.header, pages: page.index + 1, digest: page.digest });
}

interface Progress extends ReceiptPosition {
  counts: ReceiptCounts;
  complete: boolean;
}
export class ReceiptImport {
  constructor(private readonly store: Store) {}

  async page(seal: ReceiptSeal, input: ReceiptPage): Promise<void> {
    const page = await validateReceiptPage(input);
    if (JSON.stringify(canonicalHeader(page.header)) !== JSON.stringify(canonicalHeader(seal.header)))
      throw new Error("Legacy receipt source changed");
    // Hash outside the synchronous transaction. All progress/conflict checks happen inside it.
    const initial = await receiptHash(canonicalHeader(seal.header));
    this.store.transaction(() => {
      const saved = this.store.get(`adoption:page:${page.index}`);
      if (saved) {
        if (saved !== page.digest) throw new Error("Conflicting legacy receipt replay");
        return;
      }
      if (this.store.get("adoption:history-sealed")) throw new Error("Legacy history is already sealed");
      const progress: Progress = JSON.parse(
        this.store.get("adoption:history-progress") ??
          JSON.stringify({
            index: 0,
            after: { kind: 0, rowid: 0 },
            previous: initial,
            counts: EMPTY_COUNTS,
            complete: false,
          }),
      );
      if (
        progress.complete ||
        progress.index !== page.index ||
        progress.previous !== page.previous ||
        progress.after.kind !== page.after.kind ||
        progress.after.rowid !== page.after.rowid ||
        page.index >= seal.pages ||
        page.complete !== (page.index + 1 === seal.pages)
      )
        throw new Error("Legacy receipt checkpoint conflict");
      const { accountId, conversationId } = seal.header;
      for (const record of page.records) {
        this.store.importLegacyReceipt(accountId, conversationId, record);
        if (record.kind === 0) progress.counts.posted++;
        else if (record.kind === 1) progress.counts.derived++;
        else {
          progress.counts.responses++;
          this.store.set(
            `observed:${accountId}:${conversationId}:derived:${record.messageId}`,
            JSON.stringify({ value: record.digest, revision: 0 }),
          );
        }
      }
      for (const kind of ["posted", "derived", "responses"] as const)
        if (progress.counts[kind] > seal.header.counts[kind]) throw new Error("Legacy receipt count overflow");
      if (
        page.complete &&
        (page.digest !== seal.digest ||
          JSON.stringify(progress.counts) !== JSON.stringify(canonicalHeader(seal.header).counts))
      )
        throw new Error("Legacy receipt final seal mismatch");
      this.store.set(
        "adoption:history-progress",
        JSON.stringify({
          ...nextReceiptPosition(page),
          counts: progress.counts,
          complete: page.complete,
        }),
      );
      this.store.set(`adoption:page:${page.index}`, page.digest);
    });
  }

  seal(seal: ReceiptSeal): void {
    this.store.transaction(() => {
      const progress: Progress | undefined = JSON.parse(this.store.get("adoption:history-progress") ?? "null");
      if (
        !progress?.complete ||
        progress.index !== seal.pages ||
        progress.previous !== seal.digest ||
        JSON.stringify(progress.counts) !== JSON.stringify(canonicalHeader(seal.header).counts) ||
        JSON.stringify(this.store.legacyReceiptCounts(seal.header.accountId, seal.header.conversationId)) !==
          JSON.stringify(progress.counts)
      )
        throw new Error("Legacy history has not been completely imported");
      if (this.store.hasUnpairedLegacyResponses(seal.header.accountId, seal.header.conversationId))
        throw new Error("Legacy response linkage is unresolved or inconsistent");
      if (
        seal.header.titleSubject &&
        seal.header.titleMessageId !== null &&
        !this.store.hasLegacyTitleReceipt(seal.header)
      )
        throw new Error("Missing authoritative title receipt");
      this.store.set("adoption:history-sealed", seal.digest);
    });
  }
}
