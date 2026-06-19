// Fills in județ (county) + localitate (locality) for saved leads that don't
// have them yet, using OpenStreetMap's free Nominatim geocoder (no key, no
// Google cost):
//   - leads with coordinates  -> reverse geocode
//   - leads with only address  -> forward geocode (also backfills coordinates)
// Processes a small batch per call (the UI repeats until `remaining` is 0) and
// throttles to ~1 request/second per Nominatim's usage policy. Every lead is
// marked "tried" so unresolvable ones don't get retried forever.

import { getLeadsMissingGeo, setLeadGeo, countLeadsMissingGeo } from "@/lib/db";

const BATCH = 12;
const UA = { "User-Agent": "lead-finder/1.0 (local lead tool)" };

type NominatimAddress = {
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  commune?: string;
};

function parseAddress(a: NominatimAddress) {
  const locality = a.city || a.town || a.village || a.municipality || a.commune || "";
  const county = (a.county || "").replace(/^Județul\s+/i, "");
  return { locality, county };
}

async function reverse(lat: number, lng: number) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ro&zoom=12`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return { locality: "", county: "" };
  const data: { address?: NominatimAddress } = await res.json();
  return parseAddress(data.address || {});
}

async function forward(address: string) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&addressdetails=1&limit=1&accept-language=ro`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const data: { lat?: string; lon?: string; address?: NominatimAddress }[] = await res.json();
  if (!data.length) return null;
  const hit = data[0];
  return { ...parseAddress(hit.address || {}), lat: Number(hit.lat), lng: Number(hit.lon) };
}

export async function POST() {
  const batch = getLeadsMissingGeo(BATCH);
  let processed = 0;

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    try {
      if (typeof lead.lat === "number" && typeof lead.lng === "number") {
        const { locality, county } = await reverse(lead.lat, lead.lng);
        setLeadGeo(lead.id, { locality, county });
      } else if (lead.address) {
        const r = await forward(lead.address);
        if (r) setLeadGeo(lead.id, { locality: r.locality, county: r.county, lat: r.lat, lng: r.lng });
        else setLeadGeo(lead.id, {}); // mark tried so we don't loop on it
      }
      processed++;
    } catch {
      // leave untried so a later run can retry network blips
    }
    if (i < batch.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  return Response.json({ processed, remaining: countLeadsMissingGeo() });
}
