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
  photos?: unknown[];
  googleMapsUri?: string;
  location?: { latitude?: number; longitude?: number };
};

function normalize(p: GooglePlace): Lead {
  const intl = p.internationalPhoneNumber || "";
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
  };
}

// Runs a single text query, paginating up to `maxPages`. Never throws — returns
// the leads found, how many requests it cost, and an error string if any.
async function searchOneTerm(
  textQuery: string,
  maxPages: number,
  apiKey: string
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

export async function POST(req: Request) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Lipsește GOOGLE_PLACES_API_KEY. Vezi README.md → Setup." },
      { status: 500 }
    );
  }

  let body: { terms?: string[]; term?: string; location?: string; pages?: number };
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
  if (terms.length === 0 || !location) {
    return Response.json(
      { error: "Alege cel puțin un tip (ex: pensiune) și o zonă (ex: Brașov)." },
      { status: 400 }
    );
  }

  // Each page is up to 20 results & costs 1 request; Google caps Text Search at 60.
  const maxPages = Math.min(Math.max(body.pages ?? 3, 1), 3);

  // Run each type's query in parallel; pages within a query stay sequential
  // (each page needs the previous page's token).
  const settled = await Promise.all(
    terms.map((t) => searchOneTerm(`${t} ${location}`, maxPages, apiKey))
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

  // Snapshot which results we already had BEFORE saving this batch.
  const existing = getExistingStatuses(found.map((l) => l.id));
  upsertLeads(found, terms.join(", ") + " — " + location);

  const results: SearchResult[] = found.map((l) => ({
    ...l,
    known: l.id in existing,
    status: existing[l.id] ?? "new",
  }));

  return Response.json({
    results,
    query: `${terms.join(", ")} — ${location}`,
    requestsUsed,
    usageToday,
    warning: firstError || undefined,
  });
}
