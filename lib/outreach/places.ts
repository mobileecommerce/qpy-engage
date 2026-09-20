/**
 * Google Places API (New) Text Search client.
 *
 * We use the official API rather than scraping maps.google.com: scraping
 * violates Google's Terms of Service and breaks whenever the page changes,
 * while the API is stable, returns structured data and is free up to a
 * monthly credit. Note the API does not expose email addresses; those are
 * found from the business website in `enrich.ts`.
 *
 * Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
 */

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  nationalPhone: string | null;
  internationalPhone: string | null;
  website: string | null;
  googleMapsUrl: string | null;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: string | null;
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
}

interface SearchTextResponse {
  places?: RawPlace[];
  nextPageToken?: string;
  error?: { message?: string; status?: string };
}

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "nextPageToken",
].join(",");

export interface SearchOptions {
  apiKey: string;
  query: string;
  regionCode?: string | null;
  languageCode?: string;
  /** Stop after this many results. Each page holds up to 20. */
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

export function mapRawPlace(p: RawPlace): PlaceResult | null {
  if (!p.id || !p.displayName?.text) return null;
  return {
    placeId: p.id,
    name: p.displayName.text,
    address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    nationalPhone: p.nationalPhoneNumber ?? null,
    internationalPhone: p.internationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    googleMapsUrl: p.googleMapsUri ?? null,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? null,
  };
}

export async function searchPlaces(options: SearchOptions): Promise<PlaceResult[]> {
  const { apiKey, query, regionCode, languageCode = "en", maxResults = 60, fetchImpl = fetch } = options;
  const results: PlaceResult[] = [];
  let pageToken: string | undefined;

  // Google allows at most 3 pages (60 results) per text query.
  for (let page = 0; page < 3 && results.length < maxResults; page++) {
    const body: Record<string, unknown> = {
      textQuery: query,
      pageSize: 20,
      languageCode,
    };
    if (regionCode) body.regionCode = regionCode;
    if (pageToken) body.pageToken = pageToken;

    const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json().catch(() => ({}))) as SearchTextResponse;
    if (!res.ok) {
      throw new Error(`Places API ${res.status}: ${data.error?.message ?? res.statusText}`);
    }

    for (const raw of data.places ?? []) {
      const mapped = mapRawPlace(raw);
      // Skip permanently closed businesses; they will never answer.
      if (mapped && mapped.businessStatus !== "CLOSED_PERMANENTLY") results.push(mapped);
      if (results.length >= maxResults) break;
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return results;
}
