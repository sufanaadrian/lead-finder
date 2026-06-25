// Data layer, backed by Supabase Postgres (see supabase/schema.sql) so it's
// shared live between everyone using the app, instead of a local file.

import { getSupabaseAdmin } from "./supabaseAdmin";
import type { Group, Lead, LeadStatus, SearchRecord, StoredLead } from "./types";
import { DEFAULT_GROUP } from "./types";

type LeadRow = {
  id: string;
  name: string;
  address: string;
  phone: string;
  whatsapp: string;
  website: string;
  rating: number;
  review_count: number;
  photo_count: number;
  maps_uri: string;
  lat: number | null;
  lng: number | null;
  locality: string | null;
  county: string | null;
  primary_type: string | null;
  type_label: string | null;
  types: string[] | null;
  groups: string[] | null;
  status: LeadStatus;
  interested: boolean;
  note: string;
  saved_at: string;
  contacted_at: string | null;
  first_query: string;
  geo_tried: boolean;
  pitch_type: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  contacted_by: string | null;
  note_by: string | null;
  assigned_to: string | null;
};

function rowToLead(r: LeadRow): StoredLead {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    phone: r.phone,
    whatsapp: r.whatsapp,
    website: r.website,
    rating: r.rating,
    reviewCount: r.review_count,
    photoCount: r.photo_count,
    mapsUri: r.maps_uri,
    lat: r.lat ?? undefined,
    lng: r.lng ?? undefined,
    locality: r.locality ?? undefined,
    county: r.county ?? undefined,
    primaryType: r.primary_type ?? undefined,
    typeLabel: r.type_label ?? undefined,
    types: r.types ?? [],
    groups: (r.groups?.length ? r.groups : [DEFAULT_GROUP]) as Group[],
    status: r.status,
    interested: r.interested,
    note: r.note,
    savedAt: r.saved_at,
    contactedAt: r.contacted_at ?? undefined,
    firstQuery: r.first_query,
    geoTried: r.geo_tried,
    pitchType: r.pitch_type ?? undefined,
    claimedBy: r.claimed_by ?? undefined,
    claimedAt: r.claimed_at ?? undefined,
    contactedBy: r.contacted_by ?? undefined,
    noteBy: r.note_by ?? undefined,
    assignedTo: r.assigned_to ?? undefined,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Records `count` Google API requests against today's tally and returns the
// running total for today.
export async function recordUsage(count: number): Promise<number> {
  const supabaseAdmin = getSupabaseAdmin();
  const day = today();
  const { data: existing } = await supabaseAdmin
    .from("usage_counters")
    .select("count")
    .eq("day", day)
    .maybeSingle();
  const newCount = (existing?.count ?? 0) + count;
  await supabaseAdmin.from("usage_counters").upsert({ day, count: newCount });
  return newCount;
}

export async function getUsageToday(): Promise<number> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data } = await supabaseAdmin
    .from("usage_counters")
    .select("count")
    .eq("day", today())
    .maybeSingle();
  return data?.count ?? 0;
}

// Merges freshly-found leads into the DB. New ones are stored as "new";
// existing ones keep their status/note/interested (so a re-search never
// clobbers "contacted"), but their scraped fields are refreshed in case the
// listing changed. The actual merge logic lives in the `upsert_leads` SQL
// function so it's one round trip no matter how many leads were found.
export async function upsertLeads(leads: Lead[], query: string): Promise<void> {
  const supabaseAdmin = getSupabaseAdmin();
  const candidates = leads.filter((l) => !l.website); // never store places that already have a website
  if (!candidates.length) return;
  const payload = candidates.map((l) => ({ ...l, firstQuery: query }));
  const { error } = await supabaseAdmin.rpc("upsert_leads", { payload });
  if (error) throw error;
}

export async function getAllLeads(): Promise<StoredLead[]> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("*")
    .order("saved_at", { ascending: false });
  if (error) throw error;
  return (data as LeadRow[]).map(rowToLead);
}

// Append a search to the history (kept for the coverage view).
export async function recordSearch(rec: SearchRecord): Promise<void> {
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await supabaseAdmin.from("searches").insert({
    at: rec.at,
    terms: rec.terms,
    group_key: rec.group,
    location: rec.location,
    area: rec.area,
    bounds: rec.bounds,
    found: rec.found,
  });
  if (error) throw error;
}

export async function getSearches(): Promise<SearchRecord[]> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("searches")
    .select("at, terms, group_key, location, area, bounds, found")
    .order("at", { ascending: false })
    .limit(200);
  if (error) throw error;
  type SearchRow = { at: string; terms: string[]; group_key: string | null; location: string | null; area: SearchRecord["area"]; bounds: SearchRecord["bounds"]; found: number };
  return (data as SearchRow[]).map((row) => ({
    at: row.at,
    terms: row.terms,
    group: (row.group_key ?? DEFAULT_GROUP) as Group,
    location: row.location ?? undefined,
    area: row.area ?? undefined,
    bounds: row.bounds ?? undefined,
    found: row.found,
  }));
}

// Removes any leads that have a website — this tool only cares about places
// without one. Returns how many were removed.
export async function purgeWebsiteLeads(): Promise<number> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("leads")
    .delete()
    .neq("website", "")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function getLeadsMissingGeo(limit: number): Promise<StoredLead[]> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin.rpc("get_leads_missing_geo", { p_limit: limit });
  if (error) throw error;
  return (data as LeadRow[]).map(rowToLead);
}

export async function countLeadsMissingGeo(): Promise<number> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin.rpc("count_leads_missing_geo");
  if (error) throw error;
  return Number(data ?? 0);
}

// Writes whatever the geocoder found and marks the lead as tried, so it
// won't be flagged/retried even if nothing usable came back.
export async function setLeadGeo(
  id: string,
  patch: { locality?: string; county?: string; lat?: number; lng?: number }
): Promise<void> {
  const supabaseAdmin = getSupabaseAdmin();
  const update: Record<string, unknown> = { geo_tried: true };
  if (patch.locality) update.locality = patch.locality;
  if (patch.county) update.county = patch.county;
  if (typeof patch.lat === "number") update.lat = patch.lat;
  if (typeof patch.lng === "number") update.lng = patch.lng;
  const { error } = await supabaseAdmin.from("leads").update(update).eq("id", id);
  if (error) throw error;
}

// Each group gets its own template, stored under its own key in the generic
// app_settings k/v table (no schema change needed for this). Turism keeps
// the original "wa_template" key so nobody's already-saved message is lost
// by this feature.
function templateKey(group: Group): string {
  return group === DEFAULT_GROUP ? "wa_template" : `wa_template:${group}`;
}

// The shared WhatsApp message template, editable from either of your
// devices (see app_settings in supabase/schema.sql). Returns null if nobody
// has saved one yet — the caller falls back to its own built-in default.
export async function getTemplate(group: Group): Promise<{ value: string; updatedBy?: string } | null> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("value, updated_by")
    .eq("key", templateKey(group))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { value: data.value, updatedBy: data.updated_by ?? undefined };
}

export async function setTemplate(value: string, group: Group, actor?: string): Promise<void> {
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await supabaseAdmin
    .from("app_settings")
    .upsert({ key: templateKey(group), value, updated_by: actor ?? null, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// For the given ids, returns the status of any that already exist in the DB.
// Used to tell, right after a search, which results we'd already saved before.
export async function getExistingStatuses(ids: string[]): Promise<Record<string, LeadStatus>> {
  if (!ids.length) return {};
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin.from("leads").select("id, status").in("id", ids);
  if (error) throw error;
  const out: Record<string, LeadStatus> = {};
  for (const row of data as { id: string; status: LeadStatus }[]) out[row.id] = row.status;
  return out;
}

// Updates a single lead's status/note/pitch type/assignment, or just claims
// it (see ClaimBanner in app/page.tsx). Stamps contactedAt/contactedBy the
// first time it moves to "contacted", and noteBy whenever the note changes —
// `actor` is whoever's making the change (lib/identity.ts), optional.
export async function updateLead(
  id: string,
  patch: {
    status?: LeadStatus;
    note?: string;
    interested?: boolean;
    pitchType?: string;
    assignedTo?: string | null;
    claim?: boolean;
    actor?: string;
  }
): Promise<StoredLead | null> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data: current, error: readError } = await supabaseAdmin
    .from("leads")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw readError;
  if (!current) return null;
  const row = current as LeadRow;

  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) {
    update.status = patch.status;
    if (patch.status === "contacted" && !row.contacted_at) {
      update.contacted_at = new Date().toISOString();
      if (patch.actor) update.contacted_by = patch.actor;
    }
  }
  if (patch.note !== undefined) {
    update.note = patch.note;
    if (patch.actor) update.note_by = patch.actor;
  }
  if (patch.interested !== undefined) update.interested = patch.interested;
  if (patch.pitchType !== undefined) update.pitch_type = patch.pitchType;
  if (patch.assignedTo !== undefined) update.assigned_to = patch.assignedTo;
  if (patch.claim && patch.actor) {
    update.claimed_by = patch.actor;
    update.claimed_at = new Date().toISOString();
  }

  const { data: updated, error: writeError } = await supabaseAdmin
    .from("leads")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (writeError) throw writeError;
  return rowToLead(updated as LeadRow);
}
