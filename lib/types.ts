// Shared types used by the API routes, the database layer, and the UI.

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
};

export type LeadStatus = "new" | "contacted" | "client" | "skip";

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Nou",
  contacted: "Contactat",
  client: "Client",
  skip: "Ignorat",
};

// What kind of place this is for the purposes of the WhatsApp pitch — picked
// by hand per lead, not guessed from Google's classification (that turned
// out unreliable: Google's primaryType often doesn't match how you'd
// actually describe the place to its owner). Defaults to "pensiune".
export type PitchType = "pensiune" | "cabana" | "chalet" | "hotel";

export const PITCH_TYPES: PitchType[] = ["pensiune", "cabana", "chalet", "hotel"];

export const PITCH_TYPE_LABELS: Record<PitchType, string> = {
  pensiune: "Pensiune",
  cabana: "Cabană",
  chalet: "Chalet",
  hotel: "Hotel",
};

// The Romanian phrase (definite article already attached) slotted into the
// WhatsApp template's {tip} placeholder — e.g. "Am observat {tip} dumneavoastră".
export const PITCH_TYPE_PHRASES: Record<PitchType, string> = {
  pensiune: "pensiunea",
  cabana: "cabana",
  chalet: "chalet-ul",
  hotel: "hotelul",
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
  pitchType?: PitchType; // hand-picked, defaults to "pensiune" when unset
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
