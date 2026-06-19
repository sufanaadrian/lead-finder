// A tiny JSON-file database. This is a single-user local tool, so a plain file
// read/modify/write is plenty — no native dependencies, easy to inspect/back up.
// File lives at data/db.json (gitignored — it holds scraped contact data).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import type { Lead, LeadStatus, StoredLead } from "./types";

const DB_PATH = path.join(process.cwd(), "data", "db.json");

type DbShape = {
  leads: Record<string, StoredLead>;
  usage: Record<string, number>; // "YYYY-MM-DD" -> Google API request count
};

function emptyDb(): DbShape {
  return { leads: {}, usage: {} };
}

function readDb(): DbShape {
  if (!existsSync(DB_PATH)) return emptyDb();
  try {
    const parsed = JSON.parse(readFileSync(DB_PATH, "utf-8"));
    return { leads: parsed.leads ?? {}, usage: parsed.usage ?? {} };
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
