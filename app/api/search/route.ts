// Calls the Google Places API (New) Text Search and returns a normalized,
// de-duplicated list of places. Filtering (no-website / has-reviews / has-photos)
// is done on the client so toggles update instantly without re-querying.

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
};

export type Lead = {
  id: string;
  name: string;
  address: string;
  phone: string;
  whatsapp: string; // digits only, "" if no phone
  website: string; // "" if none
  rating: number;
  reviewCount: number;
  photoCount: number;
  mapsUri: string;
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

  let body: { term?: string; location?: string; maxPages?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  }

  const term = (body.term || "").trim();
  const location = (body.location || "").trim();
  if (!term || !location) {
    return Response.json(
      { error: "Completează atât tipul (ex: pensiune), cât și zona (ex: Brașov)." },
      { status: 400 }
    );
  }

  const textQuery = `${term} ${location}`;
  // Each page is up to 20 results; Google caps Text Search at 60 (3 pages).
  const maxPages = Math.min(Math.max(body.maxPages ?? 3, 1), 3);

  const all: Lead[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  try {
    for (let page = 0; page < maxPages; page++) {
      const res = await fetch(SEARCH_URL, {
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

      if (!res.ok) {
        const detail = await res.text();
        return Response.json(
          { error: `Eroare de la Google (${res.status}). ${detail.slice(0, 300)}` },
          { status: 502 }
        );
      }

      const data: { places?: GooglePlace[]; nextPageToken?: string } = await res.json();
      for (const p of data.places || []) {
        const lead = normalize(p);
        if (seen.has(lead.id)) continue;
        seen.add(lead.id);
        all.push(lead);
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
      // The next page token needs a brief moment to become valid.
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    return Response.json({ error: `Eroare de rețea: ${String(err)}` }, { status: 502 });
  }

  return Response.json({ leads: all, query: textQuery });
}
