import assert from "node:assert/strict";
import test from "node:test";
import { signLeadId, unsubscribeUrl, verifyLeadSignature } from "../../lib/outreach/signing.ts";

test("signatures verify only for the same lead and secret", async () => {
  const sig = await signLeadId(42, "secret");
  assert.equal(await verifyLeadSignature(42, sig, "secret"), true);
  assert.equal(await verifyLeadSignature(43, sig, "secret"), false);
  assert.equal(await verifyLeadSignature(42, sig, "other"), false);
  assert.equal(await verifyLeadSignature(42, "short", "secret"), false);
});

test("builds an unsubscribe url on the public origin", async () => {
  const url = await unsubscribeUrl("https://wavely.example/", 7, "secret");
  assert.match(url, /^https:\/\/wavely\.example\/api\/outreach\/unsubscribe\?lead=7&sig=[0-9a-f]{32}$/);
});
