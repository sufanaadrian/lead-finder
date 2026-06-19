// Calls the Google Places API (New) Text Search, records how many requests it
// used (for quota tracking), saves the results to the local DB (for dedup), and
// returns each result annotated with whether we've seen it before.

import { recordUsage, upsertLeads, getExistingStatuses } from "@/lib/db";
import type { Lead, SearchResult } from "@/lib/types";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Fields we ask Google for. Keep this tight — phone & website are billed at a
// higher SKU, but they're exactly what we need, so it's worth it.
const FIELD_MASK = [
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
  "nextPageToken",
].join(",");

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
};

function normalize(p: GooglePlace): Lead {
  const intl = p.internationalPhoneNumber || "";
  const photos = (Array.isArray(p.photos) ? p.photos : [])
    .map((ph) => ph?.name)
    .filter((n): n is string => !!n)
    .slice(0, 10); // cap stored references; we only display a handful
  return {
    id: p.id || crypto.randomUUID(),
    name: p.displayName?.text || "(fără nume)",
    address: p.formattedAddress || "",
    phone: p.nationalPhoneNumber || intl || "",
    whatsapp: intl.replace(/[^\d]/g, ""),
    website: p.websiteUri || "",
    rating: p.rating ?? 0,
    reviewCount: p.userRatingCount ?? 0,
    photoCount: photos.length,
    photos,
    mapsUri: p.googleMapsUri || "",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
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
  const rect = area ? circleToRectangle(area.lat, area.lng, area.radiusKm) : undefined;
  const settled = await Promise.all(
    terms.map((t) => searchOneTerm(area ? t : `${t} ${location}`, maxPages, apiKey, rect))
  );

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
