// Calls the Google Places API (New) Text Search, records how many requests it
// used (for quota tracking), saves the results to the local DB (for dedup), and
// returns each result annotated with whether we've seen it before.
//
// Google hard-caps a single Text Search at 60 results (3 pages of 20) and a
// single Nearby Search at 20 — there's no parameter that lifts this, it's
// enforced server-side, so a dense area silently loses everything past the
// cap no matter how many pages we ask for. The fix is to split the requested
// area into a grid of smaller tiles, query each one separately, and merge +
// dedup the results (see `tilesFor`). A typed location (no map pin) is first
// geocoded — free, via Nominatim — into a center + radius so it goes through
// the exact same tiling path as a map-picked area.

import { recordUsage, upsertLeads, getExistingStatuses, recordSearch } from "@/lib/db";
import type { Lead, SearchResult } from "@/lib/types";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const GEOCODE_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_UA = { "User-Agent": "lead-finder/1.0 (local lead tool)" };

// Lodging-related Google place types — used for category search so we catch
// places regardless of how they're named (English, "A-frame", etc.). This is
// the fallback set for custom/unrecognized search terms; known terms use the
// narrower mapping below instead.
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
  "extended_stay_hotel",
  "farmstay",
  "campground",
  "camping_cabin",
  "rv_park",
];

// Which Google place types best match each known search term — keeps the
// category (Nearby) search scoped to what was actually asked for, instead of
// always pulling in every lodging type. Without this, a "camping" search
// would also surface random city hotels just because they share the broad
// "lodging" category — exactly the kind of noise (e.g. generic city listings
// that will never want a custom site) we want to avoid. Unrecognized/custom
// terms fall back to the full LODGING_TYPES list so we never miss something
// obscure.
const TERM_TYPE_HINTS: Record<string, string[]> = {
  "pensiune": ["guest_house", "bed_and_breakfast", "farmstay", "inn", "cottage"],
  "cabană": ["cottage", "camping_cabin", "lodging"],
  "casă de vacanță": ["cottage", "lodging", "farmstay"],
  "hotel": ["hotel", "resort_hotel", "extended_stay_hotel"],
  "vilă": ["cottage", "lodging"],
  "motel": ["motel"],
  "hostel": ["hostel"],
  "camping": ["campground", "camping_cabin", "rv_park"],
  "a-frame": ["cottage", "camping_cabin", "lodging"],
  "bungalow": ["cottage", "camping_cabin", "lodging"],
};

// Union of place types for the category search, scoped to the chosen terms.
// If any selected term isn't in the hint map (a custom type), we can't be
// sure what it means, so we stay broad rather than risk missing matches.
function categoryTypesFor(terms: string[]): string[] {
  const hints = terms.map((t) => TERM_TYPE_HINTS[t.toLowerCase()]);
  if (hints.some((h) => !h)) return LODGING_TYPES;
  const union = new Set<string>();
  for (const h of hints) for (const t of h!) union.add(t);
  return Array.from(union);
}

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

type Tile = { lat: number; lng: number; radiusKm: number };

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
  apiKey: string,
  types: string[]
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
        includedTypes: types,
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

const MIN_TILE_RADIUS_KM = 3;
const MAX_TILES = 16; // hard ceiling on requests/cost per search

// Splits a circle into a grid of smaller, slightly-overlapping circles so no
// single Google query has to cover more area than it can actually report
// back (anything past Google's per-request cap is silently dropped, not
// "more results" — tiling is the only way around that).
function tileCircle(lat: number, lng: number, radiusKm: number, tileRadiusKm: number): Tile[] {
  if (radiusKm <= tileRadiusKm * 1.3) return [{ lat, lng, radiusKm }];
  const step = tileRadiusKm * 1.3; // slight overlap so we don't leave gaps at the seams
  const dLat = step / 111.32;
  const dLng = step / (111.32 * Math.cos((lat * Math.PI) / 180) || 1);
  const n = Math.ceil(radiusKm / step);
  const tiles: Tile[] = [];
  for (let yi = -n; yi <= n; yi++) {
    for (let xi = -n; xi <= n; xi++) {
      const tLat = lat + yi * dLat;
      const tLng = lng + xi * dLng;
      if (distanceKm(lat, lng, tLat, tLng) > radiusKm + tileRadiusKm * 0.3) continue;
      tiles.push({ lat: tLat, lng: tLng, radiusKm: tileRadiusKm });
    }
  }
  return tiles;
}

// Picks the coarsest tiling that still fits within MAX_TILES, growing tile
// size until the grid is affordable. Small areas need no tiling at all — they
// come back as a single tile, identical to the old behavior.
function tilesFor(lat: number, lng: number, radiusKm: number): Tile[] {
  let tileRadius = MIN_TILE_RADIUS_KM;
  let tiles = tileCircle(lat, lng, radiusKm, tileRadius);
  while (tiles.length > MAX_TILES) {
    tileRadius *= 1.3;
    tiles = tileCircle(lat, lng, radiusKm, tileRadius);
  }
  return tiles;
}

type GeocodeResult = { lat: number; lng: number; radiusKm: number; label: string } | null;

// Resolves a typed location ("Brașov", "Valea Prahovei") to a center + radius
// using Nominatim (free, no key) so text searches can go through the same
// tiling + category-search path as map-picked areas, instead of relying on a
// single Google query capped at 60 results. Failure here is never fatal —
// callers fall back to the old single-query behavior.
async function geocodeLocation(text: string): Promise<GeocodeResult> {
  const url = `${GEOCODE_URL}?q=${encodeURIComponent(text)}&format=json&addressdetails=0&limit=1&countrycodes=ro`;
  let res: Response;
  try {
    res = await fetch(url, { headers: NOMINATIM_UA });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data: { lat?: string; lon?: string; display_name?: string; boundingbox?: string[] }[];
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!data.length) return null;
  const hit = data[0];
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let radiusKm = 8; // sensible default when there's no usable bounding box
  const bbox = hit.boundingbox?.map(Number);
  if (bbox && bbox.length === 4 && bbox.every(Number.isFinite)) {
    const [south, , , east] = bbox;
    radiusKm = Math.max(distanceKm(lat, lng, south, lng), distanceKm(lat, lng, lat, east));
  }
  radiusKm = Math.min(Math.max(radiusKm, 2), 50);

  return { lat, lng, radiusKm, label: hit.display_name || text };
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
  const mapArea =
    body.area && typeof body.area.lat === "number" && typeof body.area.lng === "number"
      ? {
          lat: body.area.lat,
          lng: body.area.lng,
          radiusKm: Math.min(Math.max(body.area.radiusKm ?? 10, 1), 50),
        }
      : null;

  if (terms.length === 0 || (!location && !mapArea)) {
    return Response.json(
      { error: "Alege cel puțin un tip (ex: pensiune) și o zonă (text sau pe hartă)." },
      { status: 400 }
    );
  }

  // Each page is up to 20 results & costs 1 request; Google caps a single
  // Text Search query at 3 pages (60 results) — that's enforced by Google,
  // not by us. We get past it by tiling (see below), not by raising this.
  const maxPages = Math.min(Math.max(body.pages ?? 3, 1), 3);

  // Resolve the effective search circle: the map pin as-is, or a typed
  // location geocoded into a center + radius. If geocoding fails, we fall
  // back to a single un-tiled query — same as the tool's original behavior.
  let effectiveArea = mapArea;
  let geoWarning = "";
  let placeLabel = location;
  if (!effectiveArea && location) {
    const geo = await geocodeLocation(location);
    if (geo) {
      effectiveArea = { lat: geo.lat, lng: geo.lng, radiusKm: geo.radiusKm };
      placeLabel = geo.label;
    } else {
      geoWarning = `Nu am putut localiza „${location}" pe hartă — căutare simplă, fără împărțire pe zone.`;
    }
  }

  const tiles = effectiveArea ? tilesFor(effectiveArea.lat, effectiveArea.lng, effectiveArea.radiusKm) : [];
  const categoryTypes = categoryTypesFor(terms);

  // With an effective area we tile it and, per tile, query each term AND run
  // a category (Nearby) search scoped to the chosen terms — this catches
  // lodging the word search would miss (English/oddly-named places) without
  // dragging in unrelated lodging types. Without an area, fall back to one
  // plain per-term query with the location appended as text.
  const settled = effectiveArea
    ? await Promise.all(
        tiles.flatMap((tile) => {
          const rect = circleToRectangle(tile.lat, tile.lng, tile.radiusKm);
          return [
            ...terms.map((t) => searchOneTerm(t, maxPages, apiKey, rect)),
            searchNearbyCategory(tile.lat, tile.lng, tile.radiusKm, apiKey, categoryTypes),
          ];
        })
      )
    : await Promise.all(terms.map((t) => searchOneTerm(`${t} ${location}`, maxPages, apiKey)));

  // Merge + dedup across all tiles/types by stable place id.
  const found: Lead[] = [];
  const seen = new Set<string>();
  let requestsUsed = 0;
  let firstError = "";
  for (const r of settled) {
    requestsUsed += r.requests;
    if (r.error && !firstError) firstError = r.error;
    for (const lead of r.leads) {
      if (seen.has(lead.id)) continue;
      // The whole tool is about places WITHOUT a website — drop the rest at
      // the source so they never enter the database.
      if (lead.website) continue;
      // With an effective area, keep only places truly inside the circle
      // (tiles are slightly overlapping, and a bbox is a bit larger than
      // the circle it bounds).
      if (effectiveArea) {
        if (typeof lead.lat !== "number" || typeof lead.lng !== "number") continue;
        if (distanceKm(effectiveArea.lat, effectiveArea.lng, lead.lat, lead.lng) > effectiveArea.radiusKm) continue;
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

  const where = effectiveArea
    ? `${Math.round(effectiveArea.radiusKm)} km în jurul ${mapArea ? "punctului ales" : `„${placeLabel}"`}`
    : location;
  const queryLabel = `${terms.join(", ")} — ${where}`;

  // Geographic extent of the results — used to shade "searched" zones on the
  // coverage map for the rare fallback case with no effective area.
  const coords = found.filter((l) => typeof l.lat === "number" && typeof l.lng === "number");
  const bounds = coords.length
    ? {
        minLat: Math.min(...coords.map((l) => l.lat!)),
        maxLat: Math.max(...coords.map((l) => l.lat!)),
        minLng: Math.min(...coords.map((l) => l.lng!)),
        maxLng: Math.max(...coords.map((l) => l.lng!)),
      }
    : undefined;

  // Snapshot which results we already had BEFORE saving this batch.
  const existing = getExistingStatuses(found.map((l) => l.id));
  upsertLeads(found, queryLabel);
  recordSearch({
    at: new Date().toISOString(),
    terms,
    location: effectiveArea ? undefined : location,
    area: effectiveArea ?? undefined,
    bounds,
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
    tilesUsed: tiles.length || undefined,
    warning: firstError || geoWarning || undefined,
  });
}
