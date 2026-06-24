// One-time import of the old data/db.json into Supabase. Safe to re-run —
// leads/searches are upserted by id, and usage counters are summed per day
// only on the first pass (re-running re-adds the same daily totals, so don't
// run this twice unless you've deleted the rows it created).
//
// Usage:
//   node --env-file=.env.local scripts/migrate-to-supabase.mjs

import { readFileSync, existsSync } from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const DB_PATH = path.join(process.cwd(), "data", "db.json");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Lipsesc NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY în mediu.");
  console.error("Rulează cu: node --env-file=.env.local scripts/migrate-to-supabase.mjs");
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`Nu există ${DB_PATH} — nimic de migrat.`);
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
const raw = JSON.parse(readFileSync(DB_PATH, "utf-8"));
const leads = Object.values(raw.leads ?? {});
const usage = Object.entries(raw.usage ?? {});
const searches = raw.searches ?? [];

console.log(`Găsite: ${leads.length} leaduri, ${usage.length} zile de utilizare, ${searches.length} căutări.`);

async function migrateLeads() {
  const rows = leads.map((l) => ({
    id: l.id,
    name: l.name ?? "",
    address: l.address ?? "",
    phone: l.phone ?? "",
    whatsapp: l.whatsapp ?? "",
    website: l.website ?? "",
    rating: l.rating ?? 0,
    review_count: l.reviewCount ?? 0,
    photo_count: l.photoCount ?? 0,
    maps_uri: l.mapsUri ?? "",
    lat: l.lat ?? null,
    lng: l.lng ?? null,
    locality: l.locality ?? null,
    county: l.county ?? null,
    primary_type: l.primaryType ?? null,
    type_label: l.typeLabel ?? null,
    status: l.status ?? "new",
    interested: !!l.interested,
    note: l.note ?? "",
    saved_at: l.savedAt ?? new Date().toISOString(),
    contacted_at: l.contactedAt ?? null,
    first_query: l.firstQuery ?? "",
    geo_tried: !!l.geoTried,
    pitch_type: l.pitchType ?? null,
  }));
  // Chunk to keep each request small.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from("leads").upsert(chunk, { onConflict: "id" });
    if (error) throw error;
    console.log(`  leads: ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
  }
}

async function migrateUsage() {
  if (!usage.length) return;
  const rows = usage.map(([day, count]) => ({ day, count }));
  const { error } = await supabase.from("usage_counters").upsert(rows, { onConflict: "day" });
  if (error) throw error;
  console.log(`  usage: ${rows.length} zile`);
}

async function migrateSearches() {
  if (!searches.length) return;
  const rows = searches.map((s) => ({
    at: s.at,
    terms: s.terms ?? [],
    location: s.location ?? null,
    area: s.area ?? null,
    bounds: s.bounds ?? null,
    found: s.found ?? 0,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from("searches").insert(chunk);
    if (error) throw error;
    console.log(`  searches: ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
  }
}

await migrateLeads();
await migrateUsage();
await migrateSearches();
console.log("Migrare completă.");
