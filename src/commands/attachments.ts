// Downloads a Discord attachment for forwarding to Chatwoot. Only Discord's CDN hosts are
// fetched, redirects are refused, and the body is read with a size cap (files are held in memory).

import type { Fetch } from "../chatwoot/api.ts";
import { fileTooLarge, isDiscordAttachmentUrl, UserError } from "./common.ts";
import type { AttachmentRef } from "./job.ts";

export async function downloadAttachment(
  file: AttachmentRef,
  maxBytes: number,
  fetch: Fetch,
): Promise<{ blob: Blob; filename: string }> {
  if (!isDiscordAttachmentUrl(file.url)) throw new UserError("Attachments must be uploaded in Discord.");

  const response = await fetch(new Request(file.url, { redirect: "manual" }));
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new UserError("Could not download the attachment from Discord.");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw fileTooLarge(maxBytes);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw fileTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const type = file.contentType || "application/octet-stream";
  return { blob: new Blob(chunks, { type }), filename: file.filename || "attachment" };
}
