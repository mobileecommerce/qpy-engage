import assert from "node:assert/strict";
import test from "node:test";
import { buildContext, isOptOutText, renderTemplate, templateParams } from "../../lib/outreach/template.ts";

const ctx = buildContext({ name: "Smile Dental", city: null }, { name: "Dental clinics", city: "Hyderabad" }, "https://x/u?lead=1&sig=abc");

test("renders placeholders and blanks unknown keys", () => {
  assert.equal(renderTemplate("Hi {{business_name}} in {{ city }} ({{sector}}) {{nope}}", ctx), "Hi Smile Dental in Hyderabad (Dental clinics) ");
  assert.equal(renderTemplate("{{unsubscribe_url}}", ctx), "https://x/u?lead=1&sig=abc");
});

test("builds WhatsApp body params in the configured order", () => {
  assert.deepEqual(templateParams("business_name,city", ctx), ["Smile Dental", "Hyderabad"]);
  assert.deepEqual(templateParams(undefined, ctx), ["Smile Dental"]);
  assert.deepEqual(templateParams("missing", ctx), ["-"]);
});

test("recognises opt-out replies", () => {
  for (const t of ["STOP", "stop please", "Unsubscribe", "Not interested", "opt out", "Remove me"]) assert.equal(isOptOutText(t), true, t);
  for (const t of ["Yes, tell me more", "How much does it cost?", "", null]) assert.equal(isOptOutText(t), false, String(t));
});
