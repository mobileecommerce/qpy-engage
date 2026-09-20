import assert from "node:assert/strict";
import test from "node:test";
import { mapRawPlace, searchPlaces } from "../../lib/outreach/places.ts";

test("maps a raw place and drops entries without id or name", () => {
  const mapped = mapRawPlace({
    id: "abc",
    displayName: { text: "Smile Dental" },
    formattedAddress: "Road 1, Hyderabad",
    location: { latitude: 17.4, longitude: 78.4 },
    internationalPhoneNumber: "+91 40 1234 5678",
    websiteUri: "https://smiledental.in",
    rating: 4.6,
    userRatingCount: 120,
  });
  assert.equal(mapped.placeId, "abc");
  assert.equal(mapped.internationalPhone, "+91 40 1234 5678");
  assert.equal(mapped.nationalPhone, null);
  assert.equal(mapRawPlace({ displayName: { text: "x" } }), null);
});

test("pages through results with the field mask and stops at the cap", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const page = requests.length;
    const places = Array.from({ length: 20 }, (_, i) => ({ id: `p${page}-${i}`, displayName: { text: `Biz ${page}-${i}` } }));
    if (page === 1) places[0].businessStatus = "CLOSED_PERMANENTLY";
    return new Response(JSON.stringify({ places, nextPageToken: page < 3 ? `tok${page}` : undefined }), { status: 200 });
  };
  const results = await searchPlaces({ apiKey: "k", query: "dental clinic in Hyderabad", regionCode: "IN", maxResults: 30, fetchImpl });
  assert.equal(results.length, 30);
  assert.equal(results.some((r) => r.businessStatus === "CLOSED_PERMANENTLY"), false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["X-Goog-Api-Key"], "k");
  assert.match(requests[0].headers["X-Goog-FieldMask"], /places\.internationalPhoneNumber/);
  assert.equal(requests[0].body.regionCode, "IN");
  assert.equal(requests[1].body.pageToken, "tok1");
});

test("surfaces API errors with the message from Google", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 403 });
  await assert.rejects(searchPlaces({ apiKey: "bad", query: "x", fetchImpl }), /Places API 403: API key not valid/);
});
