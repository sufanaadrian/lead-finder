// Calls the Google Places API (New) Text Search, records how many requests it
// used (for quota tracking), saves the results to the local DB (for dedup), and
// returns each result annotated with whether we've seen it before.

import { recordUsage, upsertLeads, getExistingStatuses, recordSearch } from "@/lib/db";
import type { Lead, SearchResult } from "@/lib/types";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";

// Lodging-related Google place types — used for category search so we catch
// places regardless of how they're named (English, "A-frame", etc.).
const LODGING_TYPES = [
  "lodging",
  "bed_and_breakfast",
  "guest_house",
  "cottage",
  "hotel",
  "motel",
  "hostel",
  "inn",
  "resort_hotel",
  "farmstay",
  "campground",
  "camping_cabin",
  "rv_park",
];

// Fields we ask Google for. Keep this tight — phone & website are billed at a
// higher SKU, but they're exactly what we need, so it's worth it.
const PLACE_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.photos",
  "places.googleMapsUri",
  "places.location",
  "places.addressComponents",
  "places.primaryType",
  "places.primaryTypeDisplayName",
];
const FIELD_MASK = [...PLACE_FIELDS, "nextPageToken"].join(",");
const NEARBY_FIELD_MASK = PLACE_FIELDS.join(","); // Nearby has no pagination

type AddressComponent = { longText?: string; shortText?: string; types?: string[] };

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  photos?: { name?: string }[];
  googleMapsUri?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: AddressComponent[];
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
};

function pickComponent(components: AddressComponent[] | undefined, type: string): string {
  const c = (components || []).find((x) => x.types?.includes(type));
  return c?.longText || c?.shortText || "";
}

function normalize(p: GooglePlace): Lead {
  const intl = p.internationalPhoneNumber || "";
  const locality =
    pickComponent(p.addressComponents, "locality") ||
    pickComponent(p.addressComponents, "administrative_area_level_2") ||
    pickComponent(p.addressComponents, "postal_town");
  return {
    id: p.id || crypto.randomUUID(),
    name: p.displayName?.text || "(fără nume)",
    address: p.formattedAddress || "",
    phone: p.nationalPhoneNumber || intl || "",
    whatsapp: intl.replace(/[^\d]/g, ""),
    website: p.websiteUri || "",
    rating: p.rating ?? 0,
    reviewCount: p.userRatingCount ?? 0,
    photoCount: Array.isArray(p.photos) ? p.photos.length : 0,
    mapsUri: p.googleMapsUri || "",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    locality,
    county: pickComponent(p.addressComponents, "administrative_area_level_1"),
    primaryType: p.primaryType || "",
    typeLabel: p.primaryTypeDisplayName?.text || "",
  };
}

type Rectangle = {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
};

// Runs a single text query, paginating up to `maxPages`. Never throws — returns
// the leads found, how many requests it cost, and an error string if any.
// When `restriction` is given, results are hard-bounded to that rectangle.
async function searchOneTerm(
  textQuery: string,
  maxPages: number,
  apiKey: string,
  restriction?: Rectangle
): Promise<{ leads: Lead[]; requests: number; error?: string }> {
  const leads: Lead[] = [];
  let pageToken: string | undefined;
  let requests = 0;

  for (let page = 0; page < maxPages; page++) {
    let res: Response;
    try {
      res = await fetch(SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery,
          languageCode: "ro",
          regionCode: "RO",
          ...(restriction ? { locationRestriction: { rectangle: restriction } } : {}),
          ...(pageToken ? { pageToken } : {}),
        }),
      });
    } catch (err) {
      return { leads, requests, error: `Eroare de rețea: ${String(err)}` };
    }
    requests++;

    if (!res.ok) {
      const detail = await res.text();
      return { leads, requests, error: `Eroare de la Google (${res.status}). ${detail.slice(0, 200)}` };
    }

    const data: { places?: GooglePlace[]; nextPageToken?: string } = await res.json();
    for (const p of data.places || []) leads.push(normalize(p));

    pageToken = data.nextPageToken;
    if (!pageToken) break;
    // The next page token needs a brief moment to become valid.
    await new Promise((r) => setTimeout(r, 1500));
  }

  return { leads, requests };
}

// Category search: finds lodging-type places in a circle, regardless of name.
// One request, up to 20 results (Nearby New has no pagination).
async function searchNearbyCategory(
  lat: number,
  lng: number,
  radiusKm: number,
  apiKey: string
): Promise<{ leads: Lead[]; requests: number; error?: string }> {
  let res: Response;
  try {
    res = await fetch(NEARBY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": NEARBY_FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: LODGING_TYPES,
        maxResultCount: 20,
        languageCode: "ro",
        regionCode: "RO",
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: Math.min(radiusKm * 1000, 50000),
          },
        },
      }),
    });
  } catch (err) {
    return { leads: [], requests: 0, error: `Eroare de rețea: ${String(err)}` };
  }
  if (!res.ok) {
    const detail = await res.text();
    return { leads: [], requests: 1, error: `Eroare Nearby (${res.status}). ${detail.slice(0, 200)}` };
  }
  const data: { places?: GooglePlace[] } = await res.json();
  return { leads: (data.places || []).map(normalize), requests: 1 };
}

// Distance in km between two lat/lng points (haversine).
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Bounding rectangle that fully contains a circle (center + radius in km).
function circleToRectangle(lat: number, lng: number, radiusKm: number): Rectangle {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180) || 1);
  return {
    low: { latitude: lat - dLat, longitude: lng - dLng },
    high: { latitude: lat + dLat, longitude: lng + dLng },
  };
}

export async function POST(req: Request) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Lipsește GOOGLE_PLACES_API_KEY. Vezi README.md → Setup." },
      { status: 500 }
    );
  }

  let body: {
    terms?: string[];
    term?: string;
    location?: string;
    pages?: number;
    area?: { lat?: number; lng?: number; radiusKm?: number };
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  }

  // Accept a list of types; fall back to the single `term` for compatibility.
  const rawTerms = body.terms ?? (body.term ? [body.term] : []);
  const terms = Array.from(
    new Set(rawTerms.map((t) => (t || "").trim()).filter(Boolean))
  );
  const location = (body.location || "").trim();

  // Either a typed location OR a map area is required.
  const area =
    body.area && typeof body.area.lat === "number" && typeof body.area.lng === "number"
      ? {
          lat: body.area.lat,
          lng: body.area.lng,
          radiusKm: Math.min(Math.max(body.area.radiusKm ?? 10, 1), 50),
        }
      : null;

  if (terms.length === 0 || (!location && !area)) {
    return Response.json(
      { error: "Alege cel puțin un tip (ex: pensiune) și o zonă (text sau pe hartă)." },
      { status: 400 }
    );
  }

  // Each page is up to 20 results & costs 1 request; Google caps Text Search at 60.
  const maxPages = Math.min(Math.max(body.pages ?? 3, 1), 3);

  // With a map area we hard-bound each query to the circle's bounding box and
  // query by type alone; otherwise we append the typed location to the query.
  // In area mode we ALSO run a category (Nearby) search so we catch lodging
  // that the word search would miss (English/oddly-named places).
  const rect = area ? circleToRectangle(area.lat, area.lng, area.radiusKm) : undefined;
  const settled = await Promise.all([
    ...terms.map((t) => searchOneTerm(area ? t : `${t} ${location}`, maxPages, apiKey, rect)),
    ...(area ? [searchNearbyCategory(area.lat, area.lng, area.radiusKm, apiKey)] : []),
  ]);

  // Merge + dedup across all types by stable place id.
  const found: Lead[] = [];
  const seen = new Set<string>();
  let requestsUsed = 0;
  let firstError = "";
  for (const r of settled) {
    requestsUsed += r.requests;
    if (r.error && !firstError) firstError = r.error;
    for (const lead of r.leads) {
      if (seen.has(lead.id)) continue;
      // With an area, keep only places truly inside the circle (the bbox is
      // a bit larger than the circle).
      if (area) {
        if (typeof lead.lat !== "number" || typeof lead.lng !== "number") continue;
        if (distanceKm(area.lat, area.lng, lead.lat, lead.lng) > area.radiusKm) continue;
      }
      seen.add(lead.id);
      found.push(lead);
    }
  }

  const usageToday = recordUsage(requestsUsed);

  // If everything failed, surface the error. If only some failed, keep going
  // with whatever we got (and pass the error along as a soft warning).
  if (firstError && found.length === 0) {
    return Response.json({ error: firstError, usageToday }, { status: 502 });
  }

  const where = area ? `${area.radiusKm} km în jurul punctului ales` : location;
  const queryLabel = `${terms.join(", ")} — ${where}`;

  // Snapshot which results we already had BEFORE saving this batch.
  const existing = getExistingStatuses(found.map((l) => l.id));
  upsertLeads(found, queryLabel);
  recordSearch({
    at: new Date().toISOString(),
    terms,
    location: area ? undefined : location,
    area: area ?? undefined,
    found: found.length,
  });

  const results: SearchResult[] = found.map((l) => ({
    ...l,
    known: l.id in existing,
    status: existing[l.id] ?? "new",
  }));

  return Response.json({
    results,
    query: queryLabel,
    requestsUsed,
    usageToday,
    warning: firstError || undefined,
  });
}
