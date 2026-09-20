import assert from "node:assert/strict";
import test from "node:test";
import { extractEmails, findEmailOnWebsite, pickBestEmail } from "../../lib/outreach/enrich.ts";

test("extracts and de-duplicates emails, ignoring assets and placeholders", () => {
  const html = `
    <a href="mailto:Info@SmileDental.in">Email us</a>
    <p>Bookings: info@smiledental.in, dr.rao@smiledental.in</p>
    <img src="logo@2x.png"> <span>user@example.com</span>
    <script>Sentry.init({dsn:"https://abc@o123.ingest.sentry.io/1"})</script>
    contact [at] smiledental [dot] in
  `;
  assert.deepEqual(extractEmails(html).sort(), ["contact@smiledental.in", "dr.rao@smiledental.in", "info@smiledental.in"]);
});

test("prefers a generic inbox on the website's own domain", () => {
  const best = pickBestEmail(["dr.rao@smiledental.in", "info@smiledental.in", "hello@agency.com"], "www.smiledental.in");
  assert.equal(best, "info@smiledental.in");
  assert.equal(pickBestEmail([], "x.com"), null);
});

test("walks homepage then contact pages using the provided fetch", async () => {
  const pages = {
    "https://smiledental.in/": "<html><body>Welcome</body></html>",
    "https://smiledental.in/contact": "<html><body>Write to hello@smiledental.in</body></html>",
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = pages[url];
    return new Response(body ?? "nope", { status: body ? 200 : 404, headers: { "content-type": "text/html" } });
  };
  const email = await findEmailOnWebsite("https://smiledental.in", { fetchImpl });
  assert.equal(email, "hello@smiledental.in");
  assert.deepEqual(calls, ["https://smiledental.in/", "https://smiledental.in/contact"]);
});

test("returns null for unusable websites without throwing", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  assert.equal(await findEmailOnWebsite("https://down.example", { fetchImpl }), null);
  assert.equal(await findEmailOnWebsite("not a url", { fetchImpl }), null);
  assert.equal(await findEmailOnWebsite("ftp://files.example", { fetchImpl }), null);
});
