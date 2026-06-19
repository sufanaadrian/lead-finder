// A tiny JSON-file database. This is a single-user local tool, so a plain file
// read/modify/write is plenty — no native dependencies, easy to inspect/back up.
// File lives at data/db.json (gitignored — it holds scraped contact data).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import type { Lead, LeadStatus, SearchRecord, StoredLead } from "./types";

const DB_PATH = path.join(process.cwd(), "data", "db.json");

type DbShape = {
  leads: Record<string, StoredLead>;
  usage: Record<string, number>; // "YYYY-MM-DD" -> Google API request count
  searches: SearchRecord[]; // history, for the coverage view
};

function emptyDb(): DbShape {
  return { leads: {}, usage: {}, searches: [] };
}

function readDb(): DbShape {
  if (!existsSync(DB_PATH)) return emptyDb();
  try {
    const parsed = JSON.parse(readFileSync(DB_PATH, "utf-8"));
    return { leads: parsed.leads ?? {}, usage: parsed.usage ?? {}, searches: parsed.searches ?? [] };
  } catch {
    return emptyDb();
  }
}

function writeDb(db: DbShape): void {
  const dir = path.dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Records `count` Google API requests against today's tally and returns the
// running total for today.
export function recordUsage(count: number): number {
  const db = readDb();
  const key = today();
  db.usage[key] = (db.usage[key] ?? 0) + count;
  writeDb(db);
  return db.usage[key];
}

export function getUsageToday(): number {
  return readDb().usage[today()] ?? 0;
}

// Merges freshly-found leads into the DB. New ones are stored as "new"; existing
// ones keep their status/note (so we never clobber "contacted"), but their
// scraped fields are refreshed in case the listing changed.
export function upsertLeads(leads: Lead[], query: string): Record<string, StoredLead> {
  const db = readDb();
  const now = new Date().toISOString();
  for (const lead of leads) {
    if (lead.website) continue; // never store places that already have a website
    const existing = db.leads[lead.id];
    if (existing) {
      db.leads[lead.id] = {
        ...existing,
        ...lead,
        status: existing.status,
        interested: existing.interested ?? false,
        note: existing.note,
      };
    } else {
      db.leads[lead.id] = {
        ...lead,
        status: "new",
        interested: false,
        note: "",
        savedAt: now,
        firstQuery: query,
      };
    }
  }
  writeDb(db);
  return db.leads;
}

export function getAllLeads(): StoredLead[] {
  return Object.values(readDb().leads).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

// Append a search to the history (keep the most recent 200).
export function recordSearch(rec: SearchRecord): void {
  const db = readDb();
  db.searches.push(rec);
  if (db.searches.length > 200) db.searches = db.searches.slice(-200);
  writeDb(db);
}

export function getSearches(): SearchRecord[] {
  return readDb().searches;
}

// Removes any leads that have a website — this tool only cares about places
// without one. Returns how many were removed. Cheap no-op if there are none.
export function purgeWebsiteLeads(): number {
  const db = readDb();
  let removed = 0;
  for (const [id, lead] of Object.entries(db.leads)) {
    if (lead.website) {
      delete db.leads[id];
      removed++;
    }
  }
  if (removed > 0) writeDb(db);
  return removed;
}

// Leads still missing locality/county that we haven't tried to enrich yet and
// that we CAN enrich (we have either coordinates or an address to geocode).
function canEnrich(l: StoredLead): boolean {
  const missing = !l.locality || !l.county;
  const hasGeoSource = (typeof l.lat === "number" && typeof l.lng === "number") || !!l.address;
  return missing && !l.geoTried && hasGeoSource;
}

export function getLeadsMissingGeo(limit: number): StoredLead[] {
  return Object.values(readDb().leads).filter(canEnrich).slice(0, limit);
}

export function countLeadsMissingGeo(): number {
  return Object.values(readDb().leads).filter(canEnrich).length;
}

// Writes whatever the geocoder found and marks the lead as tried, so it won't
// be flagged/retried even if nothing usable came back.
export function setLeadGeo(
  id: string,
  patch: { locality?: string; county?: string; lat?: number; lng?: number }
): void {
  const db = readDb();
  const lead = db.leads[id];
  if (!lead) return;
  if (patch.locality) lead.locality = patch.locality;
  if (patch.county) lead.county = patch.county;
  if (typeof patch.lat === "number") lead.lat = patch.lat;
  if (typeof patch.lng === "number") lead.lng = patch.lng;
  lead.geoTried = true;
  db.leads[id] = lead;
  writeDb(db);
}

// For the given ids, returns the status of any that already exist in the DB.
// Used to tell, right after a search, which results we'd already saved before.
export function getExistingStatuses(ids: string[]): Record<string, LeadStatus> {
  const db = readDb();
  const out: Record<string, LeadStatus> = {};
  for (const id of ids) {
    if (db.leads[id]) out[id] = db.leads[id].status;
  }
  return out;
}

// Updates a single lead's status and/or note. Stamps contactedAt the first time
// it moves to "contacted".
export function updateLead(
  id: string,
  patch: { status?: LeadStatus; note?: string; interested?: boolean }
): StoredLead | null {
  const db = readDb();
  const lead = db.leads[id];
  if (!lead) return null;
  if (patch.status !== undefined) {
    lead.status = patch.status;
    if (patch.status === "contacted" && !lead.contactedAt) {
      lead.contactedAt = new Date().toISOString();
    }
  }
  if (patch.note !== undefined) lead.note = patch.note;
  if (patch.interested !== undefined) lead.interested = patch.interested;
  db.leads[id] = lead;
  writeDb(db);
  return lead;
}
