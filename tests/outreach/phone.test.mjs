import assert from "node:assert/strict";
import test from "node:test";
import { toE164Digits } from "../../lib/outreach/phone.ts";

test("keeps international numbers, stripping formatting", () => {
  assert.equal(toE164Digits("+91 40 1234 5678", "91"), "914012345678");
  assert.equal(toE164Digits("+1 (415) 555-0132", "91"), "14155550132");
});

test("adds the default country code to national numbers and drops the trunk zero", () => {
  assert.equal(toE164Digits("040 1234 5678", "91"), "914012345678");
  assert.equal(toE164Digits("098765 43210", "91"), "919876543210");
  assert.equal(toE164Digits("9876543210", "91"), "919876543210");
});

test("handles 00 international prefix", () => {
  assert.equal(toE164Digits("0091 98765 43210", "91"), "919876543210");
});

test("rejects garbage", () => {
  assert.equal(toE164Digits("", "91"), null);
  assert.equal(toE164Digits(null, "91"), null);
  assert.equal(toE164Digits("call us", "91"), null);
  assert.equal(toE164Digits("+1234", "91"), null);
});
