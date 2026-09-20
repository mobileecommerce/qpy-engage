import assert from "node:assert/strict";
import test from "node:test";
import { createTestD1 } from "./helpers/d1-shim.mjs";
import { getOutreachDb, handleWhatsAppWebhook, getStats, runDiscovery, runMorningSend, upsertSectors, validateSectorInput } from "../../lib/outreach/pipeline.ts";
import { handleOutreachRequest } from "../../lib/outreach/routes.ts";

const PLACES = [
  { id: "p1", displayName: { text: "Smile Dental" }, formattedAddress: "Road 1", internationalPhoneNumber: "+91 98765 43210", websiteUri: "https://smiledental.in" },
  { id: "p2", displayName: { text: "Pearl Dental" }, formattedAddress: "Road 2", nationalPhoneNumber: "040 2345 6789" },
  { id: "p3", displayName: { text: "Web Only Dental" }, formattedAddress: "Road 3", websiteUri: "https://webonly.in" },
  { id: "p4", displayName: { text: "Ghost Dental" }, formattedAddress: "Road 4" },
];

function fakeFetch(log) {
  return async (url, init) => {
    log.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const u = String(url);
    if (u.startsWith("https://places.googleapis.com")) return new Response(JSON.stringify({ places: PLACES }), { status: 200 });
    if (u.startsWith("https://smiledental.in")) return new Response("<a href='mailto:info@smiledental.in'>mail</a>", { headers: { "content-type": "text/html" } });
    if (u.startsWith("https://webonly.in")) return new Response("<p>no email here</p>", { headers: { "content-type": "text/html" } });
    if (u.startsWith("https://graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: `wamid.${log.length}` }] }), { status: 200 });
    if (u.startsWith("https://api.resend.com")) return new Response(JSON.stringify({ id: `email.${log.length}` }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

async function setup(overrides = {}) {
  const DB = await createTestD1();
  const env = {
    DB,
    OUTREACH_ADMIN_TOKEN: "admin-secret",
    OUTREACH_PUBLIC_ORIGIN: "https://wavely.test",
    GOOGLE_MAPS_API_KEY: "g",
    WHATSAPP_ACCESS_TOKEN: "t",
    WHATSAPP_PHONE_NUMBER_ID: "111",
    WHATSAPP_TEMPLATE_NAME: "intro",
    RESEND_API_KEY: "r",
    OUTREACH_FROM_EMAIL: "Praveen <p@wavely.test>",
    OUTREACH_DAILY_SEND_CAP: "10",
    OUTREACH_MAX_TOUCHES: "2",
    OUTREACH_FOLLOW_UP_DAYS: "4",
    ...overrides,
  };
  const db = getOutreachDb(env);
  await upsertSectors(db, [
    validateSectorInput({ slug: "dental-hyd", name: "Dental clinics", searchQuery: "dental clinic in Hyderabad", city: "Hyderabad", emailSubject: "Hi {{business_name}}", emailBody: "Hello {{business_name}} in {{city}}" }),
  ]);
  return { env, db };
}

test("discovery imports places once, finds emails and classifies reachability", async () => {
  const { env, db } = await setup();
  const log = [];
  const first = await runDiscovery(env, { fetchImpl: fakeFetch(log) });
  assert.deepEqual(first.sectors, [{ slug: "dental-hyd", found: 4, inserted: 4 }]);
  assert.equal(first.enriched, 1);
  assert.equal(first.ready, 2); // Smile (phone+email) and Pearl (phone)
  assert.equal(first.unreachable, 1); // Ghost: nothing at all
  assert.deepEqual(first.errors, []);

  // Web Only Dental stays "new" for one more attempt, then becomes unreachable.
  const second = await runDiscovery(env, { fetchImpl: fakeFetch(log) });
  assert.deepEqual(second.sectors, [{ slug: "dental-hyd", found: 4, inserted: 0 }]);
  assert.equal(second.unreachable, 1);

  const stats = await getStats(db);
  assert.deepEqual(stats.leadsByStatus, { ready: 2, unreachable: 2 });
  const rows = env.DB._raw.prepare("select name, phone_e164, email from leads order by id").all();
  assert.deepEqual(rows, [
    { name: "Smile Dental", phone_e164: "919876543210", email: "info@smiledental.in" },
    { name: "Pearl Dental", phone_e164: "914023456789", email: null },
    { name: "Web Only Dental", phone_e164: null, email: null },
    { name: "Ghost Dental", phone_e164: null, email: null },
  ]);
});

test("morning send: WhatsApp first, follow-up on email after the wait, then exhausted", async () => {
  const { env } = await setup();
  const log = [];
  await runDiscovery(env, { fetchImpl: fakeFetch(log) });

  const day1 = await runMorningSend(env, { fetchImpl: fakeFetch(log) });
  assert.equal(day1.sent, 2);
  assert.equal(day1.failed, 0);
  const waCalls = log.filter((l) => l.url.includes("graph.facebook.com"));
  assert.equal(waCalls.length, 2);
  assert.deepEqual(waCalls.map((c) => c.body.to).sort(), ["914023456789", "919876543210"]);
  assert.deepEqual(waCalls[0].body.template.components[0].parameters, [{ type: "text", text: "Smile Dental" }]);

  // Same day again: nothing is due, nobody gets a second message today.
  const sameDay = await runMorningSend(env, { fetchImpl: fakeFetch(log) });
  assert.equal(sameDay.attempted, 0);
  assert.equal(sameDay.alreadySentToday, 2);

  // Fast-forward: make follow-ups due.
  env.DB._raw.exec("update leads set next_contact_at = '2000-01-01T00:00:00.000Z'");
  const day5 = await runMorningSend(env, { fetchImpl: fakeFetch(log) });
  assert.equal(day5.sent, 2);
  const emails = log.filter((l) => l.url.includes("api.resend.com"));
  assert.equal(emails.length, 1, "Smile Dental has an email, so its follow-up switches channel");
  assert.equal(emails[0].body.to[0], "info@smiledental.in");
  assert.equal(emails[0].body.subject, "Hi Smile Dental");
  assert.match(emails[0].body.text, /Hello Smile Dental in Hyderabad/);
  assert.match(emails[0].body.text, /https:\/\/wavely\.test\/api\/outreach\/unsubscribe\?lead=\d+&sig=[0-9a-f]{32}/);
  assert.match(emails[0].body.headers["List-Unsubscribe"], /^<https:\/\/wavely\.test/);

  const statuses = env.DB._raw.prepare("select status, touches from leads where phone_e164 is not null").all();
  assert.deepEqual(statuses, [
    { status: "exhausted", touches: 2 },
    { status: "exhausted", touches: 2 },
  ]);
});

test("daily cap and dry run are respected", async () => {
  const { env } = await setup({ OUTREACH_DAILY_SEND_CAP: "1", OUTREACH_DRY_RUN: "true" });
  const log = [];
  await runDiscovery(env, { fetchImpl: fakeFetch(log) });
  const res = await runMorningSend(env, { fetchImpl: fakeFetch(log) });
  assert.equal(res.sent, 1);
  assert.equal(res.dryRun, true);
  assert.equal(log.some((l) => l.url.includes("graph.facebook.com")), false, "dry run must not call WhatsApp");
  const msg = env.DB._raw.prepare("select status from outreach_messages").all();
  assert.deepEqual(msg, [{ status: "dry_run" }]);
});

test("replies stop automation and STOP opts out; unsubscribe link and admin auth work", async () => {
  const { env } = await setup();
  const log = [];
  await runDiscovery(env, { fetchImpl: fakeFetch(log) });
  await runMorningSend(env, { fetchImpl: fakeFetch(log) });

  const webhook = (from, text) => ({ entry: [{ changes: [{ value: { messages: [{ from, id: `wamid.in.${from}`, type: "text", text: { body: text } }] } }] }] });
  const r1 = await handleWhatsAppWebhook(env, webhook("919876543210", "Yes, tell me more"));
  const r2 = await handleWhatsAppWebhook(env, webhook("914023456789", "STOP"));
  assert.deepEqual(r1, { replies: 1, optOuts: 0, statuses: 0 });
  assert.deepEqual(r2, { replies: 0, optOuts: 1, statuses: 0 });
  const rows = env.DB._raw.prepare("select name, status from leads where phone_e164 is not null order by id").all();
  assert.deepEqual(rows, [
    { name: "Smile Dental", status: "replied" },
    { name: "Pearl Dental", status: "opted_out" },
  ]);
  assert.equal(env.DB._raw.prepare("select count(*) as n from opt_outs").get().n, 1);

  // Nothing further goes out even when due.
  env.DB._raw.exec("update leads set next_contact_at = '2000-01-01T00:00:00.000Z'");
  const later = await runMorningSend(env, { fetchImpl: fakeFetch(log) });
  assert.equal(later.attempted, 0);

  // Delivery status update lands on the right message.
  const sentId = env.DB._raw.prepare("select provider_message_id as id from outreach_messages where status = 'sent' limit 1").get().id;
  await handleWhatsAppWebhook(env, { entry: [{ changes: [{ value: { statuses: [{ id: sentId, status: "delivered", recipient_id: "919876543210" }] } }] }] });
  assert.equal(env.DB._raw.prepare("select status from outreach_messages where provider_message_id = ?").get(sentId).status, "delivered");

  // Admin routes need the bearer token.
  const denied = await handleOutreachRequest(new Request("https://wavely.test/api/outreach/stats"), env);
  assert.equal(denied.status, 401);
  const ok = await handleOutreachRequest(new Request("https://wavely.test/api/outreach/stats", { headers: { Authorization: "Bearer admin-secret" } }), env);
  assert.equal(ok.status, 200);
  const stats = await ok.json();
  assert.equal(stats.leadsByStatus.replied, 1);

  // Webhook verification handshake.
  const verify = await handleOutreachRequest(new Request("https://wavely.test/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=v&hub.challenge=123"), { ...env, WHATSAPP_VERIFY_TOKEN: "v" });
  assert.equal(await verify.text(), "123");

  // Signed unsubscribe link: a wrong signature is rejected, the right one opts the lead out.
  const emailLead = env.DB._raw.prepare("select id from leads where email is not null").get().id;
  const bad = await handleOutreachRequest(new Request(`https://wavely.test/api/outreach/unsubscribe?lead=${emailLead}&sig=deadbeef`), env);
  assert.equal(bad.status, 400);
  const { unsubscribeUrl } = await import("../../lib/outreach/signing.ts");
  const good = await handleOutreachRequest(new Request(await unsubscribeUrl("https://wavely.test", emailLead, "admin-secret")), env);
  assert.equal(good.status, 200);
  assert.equal(env.DB._raw.prepare("select count(*) as n from opt_outs where identifier = 'info@smiledental.in'").get().n, 1);
});
