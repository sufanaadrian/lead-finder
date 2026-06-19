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
  photos?: string[]; // Google photo resource names ("places/<id>/photos/<ref>")
  mapsUri: string;
  lat?: number;
  lng?: number;
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
  note: string;
  savedAt: string;
  contactedAt?: string;
  firstQuery: string;
};

// A search result handed to the UI: the fresh data, plus whether we've seen it
// before and (if so) what status it has.
export type SearchResult = Lead & {
  known: boolean;
  status: LeadStatus;
};
