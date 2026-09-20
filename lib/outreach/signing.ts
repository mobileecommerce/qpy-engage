/** HMAC-signed unsubscribe links so nobody can opt out someone else by guessing IDs. */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signLeadId(leadId: number, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`unsubscribe:${leadId}`));
  return toHex(sig).slice(0, 32);
}

export async function verifyLeadSignature(leadId: number, signature: string, secret: string): Promise<boolean> {
  const expected = await signLeadId(leadId, secret);
  if (expected.length !== signature.length) return false;
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function unsubscribeUrl(origin: string, leadId: number, secret: string): Promise<string> {
  const sig = await signLeadId(leadId, secret);
  return `${origin.replace(/\/$/, "")}/api/outreach/unsubscribe?lead=${leadId}&sig=${sig}`;
}
