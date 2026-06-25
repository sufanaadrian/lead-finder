// Shared types used by the API routes, the database layer, and the UI.

// Business vertical a lead belongs to — search terms, Google place-type
// mappings, WhatsApp pitch wording and templates are all scoped per group
// (see lib/groups.ts). A lead can belong to more than one (e.g. a guesthouse
// that also runs a restaurant), computed from Google's own classification
// rather than from which group tab you happened to search from.
export type Group = "turism" | "restaurante" | "evenimente" | "constructii" | "beauty";

export const GROUPS: Group[] = ["turism", "restaurante", "evenimente", "constructii", "beauty"];

export const GROUP_LABELS: Record<Group, string> = {
  turism: "🏡 Turism & Cazare",
  restaurante: "🍽️ Restaurante & Cafenele",
  evenimente: "🎉 Evenimente & Distracție",
  constructii: "🏗️ Construcții & Amenajări",
  beauty: "💇 Beauty & Wellness",
};

export const DEFAULT_GROUP: Group = "turism";

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
  lat?: number;
  lng?: number;
  locality?: string; // city / commune
  county?: string; // județ
  primaryType?: string; // raw Google type, e.g. "guest_house"
  typeLabel?: string; // localized label, e.g. "Pensiune"
  types: string[]; // all Google place types for this place (primaryType plus the rest)
  groups: Group[]; // which business verticals this place matches — see lib/groups.ts groupsForTypes()
};

export type LeadStatus = "new" | "contacted" | "client" | "skip";

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Nou",
  contacted: "Contactat",
  client: "Client",
  skip: "Ignorat",
};

// A lead as kept in the local database — the scraped data plus our own notes.
export type StoredLead = Lead & {
  status: LeadStatus;
  interested: boolean; // shortlist flag for bulk follow-up
  note: string;
  savedAt: string;
  contactedAt?: string;
  firstQuery: string;
  geoTried?: boolean; // we've attempted to fill locality/county (avoid retrying forever)
  // Hand-picked kind of place for the WhatsApp {tip} placeholder — a free
  // string scoped to whichever group it was set under (see
  // GROUP_PITCH_OPTIONS in lib/groups.ts), not a single global enum, since
  // "pensiune" means nothing for a hair salon.
  pitchType?: string;
  claimedBy?: string; // who last opened WhatsApp for this lead (soft lock, see ClaimBanner)
  claimedAt?: string;
  contactedBy?: string; // who actually sent the first message
  noteBy?: string; // who last edited the note
  assignedTo?: string; // who's working this lead (manual, for splitting territory)
};

// A search result handed to the UI: the fresh data, plus whether we've seen it
// before and (if so) what status it has.
export type SearchResult = Lead & {
  known: boolean;
  status: LeadStatus;
};

// One past search, kept so we can show coverage (where we've already looked).
export type SearchRecord = {
  at: string;
  terms: string[];
  group: Group;
  location?: string;
  area?: { lat: number; lng: number; radiusKm: number };
  bounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  found: number;
};

// How good a lead is as a website-sales target. Every lead here already has
// no website (that's a precondition, not a differentiator), so this ranks by
// what actually varies: reachable + well-rated + active (reviewed,
// photographed) businesses score highest.
export function scoreLead(l: {
  phone: string;
  rating: number;
  reviewCount: number;
  photoCount: number;
}): number {
  let s = 0;
  if (l.phone) s += 4; // must be reachable to contact at all
  s += (l.rating || 0) / 5 * 3; // up to +3 — quality/legitimacy of the business
  s += Math.min(l.reviewCount, 50) / 10; // up to +5 — how active/established it is
  s += Math.min(l.photoCount, 10) / 5; // up to +2 — content to build a site from
  return Math.round(s * 10) / 10;
}
