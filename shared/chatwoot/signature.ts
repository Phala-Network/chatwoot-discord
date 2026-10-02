const TIMESTAMP_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

export function isFreshTimestamp(timestamp: string | undefined, nowSeconds: number): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(nowSeconds - Number(timestamp)) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/** Constant-time check (WebCrypto HMAC verify) of a Chatwoot webhook signature. */
export async function verifyChatwootSignature(
  secret: string,
  timestamp: string,
  body: Uint8Array,
  signatureHeader: string | undefined,
): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader ?? "");
  const hex = match?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  return crypto.subtle.verify("HMAC", key, Uint8Array.fromHex(hex), signed);
}
