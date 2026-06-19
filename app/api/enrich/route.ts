// Fills in județ (county) + localitate (locality) for saved leads that have
// coordinates but no area info yet, using OpenStreetMap's free Nominatim
// reverse geocoder (no key, no Google cost). Processes a small batch per call
// — the UI calls it repeatedly until `remaining` reaches 0 — and throttles to
// respect Nominatim's ~1 request/second usage policy.

import { getLeadsMissingGeo, setLeadGeo, countLeadsMissingGeo } from "@/lib/db";

const BATCH = 15;

type NominatimAddress = {
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  commune?: string;
};

async function reverseGeocode(lat: number, lng: number): Promise<{ locality: string; county: string }> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ro&zoom=12`;
  const res = await fetch(url, {
    headers: { "User-Agent": "lead-finder/1.0 (local lead tool)" },
  });
  if (!res.ok) return { locality: "", county: "" };
  const data: { address?: NominatimAddress } = await res.json();
  const a = data.address || {};
  const locality = a.city || a.town || a.village || a.municipality || a.commune || "";
  const county = (a.county || "").replace(/^Județul\s+/i, "");
  return { locality, county };
}

export async function POST() {
  const batch = getLeadsMissingGeo(BATCH);
  let processed = 0;

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    try {
      const { locality, county } = await reverseGeocode(lead.lat!, lead.lng!);
      // Store even a partial result so we don't retry it forever.
      setLeadGeo(lead.id, locality || lead.locality || "necunoscut", county || lead.county || "necunoscut");
      processed++;
    } catch {
      // skip; will be retried next run
    }
    // Throttle to stay within Nominatim's usage policy (~1 req/s).
    if (i < batch.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  return Response.json({ processed, remaining: countLeadsMissingGeo() });
}
