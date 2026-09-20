import assert from "node:assert/strict";
import test from "node:test";
import { parseWebhook, sendWhatsAppTemplate } from "../../lib/outreach/whatsapp.ts";

test("parses inbound messages and delivery statuses from a Meta webhook payload", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: "+91 98765 43210", id: "wamid.1", type: "text", text: { body: "STOP" } }],
              statuses: [{ id: "wamid.0", status: "failed", recipient_id: "919876543210", errors: [{ title: "Undeliverable" }] }],
            },
          },
        ],
      },
    ],
  };
  const { messages, statuses } = parseWebhook(payload);
  assert.deepEqual(messages, [{ from: "919876543210", providerMessageId: "wamid.1", type: "text", text: "STOP" }]);
  assert.deepEqual(statuses, [{ providerMessageId: "wamid.0", status: "failed", recipient: "919876543210", error: "Undeliverable" }]);
  assert.deepEqual(parseWebhook(null), { messages: [], statuses: [] });
});

test("sends a template message and returns the provider id", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return new Response(JSON.stringify({ messages: [{ id: "wamid.abc" }] }), { status: 200 });
  };
  const env = { WHATSAPP_ACCESS_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_TEMPLATE_NAME: "intro" };
  const res = await sendWhatsAppTemplate(env, { to: "919876543210", templateName: "intro", languageCode: "en", bodyParams: ["Smile Dental"] }, fetchImpl);
  assert.deepEqual(res, { ok: true, providerMessageId: "wamid.abc" });
  assert.equal(captured.url, "https://graph.facebook.com/v21.0/123/messages");
  assert.equal(captured.auth, "Bearer tok");
  assert.equal(captured.body.to, "919876543210");
  assert.equal(captured.body.template.name, "intro");
  assert.deepEqual(captured.body.template.components[0].parameters, [{ type: "text", text: "Smile Dental" }]);
});

test("reports missing configuration and provider errors without throwing", async () => {
  const missing = await sendWhatsAppTemplate({}, { to: "1", templateName: "t", languageCode: "en", bodyParams: [] });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /WHATSAPP_ACCESS_TOKEN/);

  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 });
  const env = { WHATSAPP_ACCESS_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_TEMPLATE_NAME: "intro" };
  const failed = await sendWhatsAppTemplate(env, { to: "1", templateName: "intro", languageCode: "en", bodyParams: [] }, fetchImpl);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /400.*Invalid parameter.*code 100/);
});
