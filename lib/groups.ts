// Per-group (business vertical) search configuration. Each group is fully
// self-contained: its own search-term chips, its own Google place-type
// mapping (so "category search" stays scoped instead of pulling in every
// type from every vertical), its own WhatsApp pitch wording, and its own
// default message template.
//
// Group membership on a lead (Lead.groups) is computed from Google's own
// classification (see groupsForTypes), not from which group tab you
// happened to search from — a guesthouse that also runs a restaurant should
// show up in both Turism and Restaurante regardless of which one found it
// first, and which group found it first shouldn't matter once it's saved.

import type { Group } from "./types";

// Chips shown in the search form, scoped per group.
export const GROUP_TERMS: Record<Group, string[]> = {
  turism: ["pensiune", "cabană", "casă de vacanță", "hotel", "vilă", "motel", "hostel", "camping", "a-frame", "bungalow"],
  restaurante: ["restaurant", "cafenea", "bar/pub", "fast-food", "pizzerie", "patiserie/cofetărie"],
  evenimente: ["sală de evenimente", "salon de nunți", "club", "bowling/sală de jocuri", "cazinou", "loc de joacă", "parc de distracții/acvatic"],
  constructii: ["constructor", "electrician", "instalator", "zugrav", "firmă acoperișuri"],
  beauty: ["salon de înfrumusețare", "frizerie/coafor", "salon manichiură", "spa", "salon masaj"],
};

// term -> Google Places (New) type hints, scoped per group. Keeps the
// category (Nearby) search tight instead of dragging in every type from the
// group's broad fallback set. Verified against Google's live place-type
// reference (developers.google.com/maps/documentation/places/web-service/place-types).
const GROUP_TERM_TYPE_HINTS: Record<Group, Record<string, string[]>> = {
  turism: {
    "pensiune": ["guest_house", "bed_and_breakfast", "farmstay", "inn", "cottage"],
    "cabană": ["cottage", "camping_cabin", "lodging"],
    "casă de vacanță": ["cottage", "lodging", "farmstay"],
    "hotel": ["hotel", "resort_hotel", "extended_stay_hotel"],
    "vilă": ["cottage", "lodging"],
    "motel": ["motel"],
    "hostel": ["hostel"],
    "camping": ["campground", "camping_cabin", "rv_park"],
    "a-frame": ["cottage", "camping_cabin", "lodging"],
    "bungalow": ["cottage", "camping_cabin", "lodging"],
  },
  restaurante: {
    "restaurant": ["restaurant", "fine_dining_restaurant", "family_restaurant"],
    "cafenea": ["cafe", "coffee_shop", "coffee_roastery"],
    "bar/pub": ["bar", "pub", "bar_and_grill", "cocktail_bar", "sports_bar"],
    "fast-food": ["fast_food_restaurant", "meal_takeaway"],
    "pizzerie": ["pizza_restaurant", "pizza_delivery"],
    "patiserie/cofetărie": ["bakery", "pastry_shop", "cake_shop", "confectionery"],
  },
  evenimente: {
    "sală de evenimente": ["event_venue", "banquet_hall"],
    "salon de nunți": ["wedding_venue", "banquet_hall"],
    "club": ["night_club", "dance_hall"],
    "bowling/sală de jocuri": ["bowling_alley", "video_arcade", "amusement_center"],
    "cazinou": ["casino"],
    "loc de joacă": ["playground", "amusement_center"],
    "parc de distracții/acvatic": ["amusement_park", "water_park"],
  },
  constructii: {
    "constructor": ["general_contractor"],
    "electrician": ["electrician"],
    "instalator": ["plumber"],
    "zugrav": ["painter"],
    "firmă acoperișuri": ["roofing_contractor"],
  },
  beauty: {
    "salon de înfrumusețare": ["beauty_salon"],
    "frizerie/coafor": ["hair_salon", "hair_care", "barber_shop"],
    "salon manichiură": ["nail_salon"],
    "spa": ["spa", "massage_spa", "sauna", "wellness_center"],
    "salon masaj": ["massage"],
  },
};

// Fallback broad set per group — used for the category (Nearby) search when
// any chosen term is custom/unrecognized (we can't be sure what it means, so
// we stay broad rather than risk missing matches), and as the membership
// vocabulary for groupsForTypes() below. Construction only padded with two
// retail types (home_improvement_store/hardware_store) since Google only
// exposes 5 actual contractor-trade types — there's no granular "renovation
// company" type to lean on.
const GROUP_FALLBACK_TYPES: Record<Group, string[]> = {
  turism: [
    "lodging", "bed_and_breakfast", "guest_house", "cottage", "hotel", "motel", "hostel",
    "inn", "resort_hotel", "extended_stay_hotel", "farmstay", "campground", "camping_cabin", "rv_park",
  ],
  restaurante: [
    "restaurant", "fine_dining_restaurant", "family_restaurant", "cafe", "coffee_shop", "coffee_roastery",
    "bar", "pub", "bar_and_grill", "cocktail_bar", "sports_bar", "fast_food_restaurant", "meal_takeaway",
    "pizza_restaurant", "pizza_delivery", "bakery", "pastry_shop", "cake_shop", "confectionery",
  ],
  evenimente: [
    "event_venue", "banquet_hall", "wedding_venue", "night_club", "dance_hall",
    "bowling_alley", "video_arcade", "amusement_center", "casino",
    "playground", "amusement_park", "water_park",
  ],
  constructii: [
    "general_contractor", "electrician", "plumber", "painter", "roofing_contractor",
    "home_improvement_store", "hardware_store",
  ],
  beauty: [
    "beauty_salon", "hair_salon", "hair_care", "barber_shop", "nail_salon",
    "spa", "massage_spa", "sauna", "wellness_center", "massage",
  ],
};

function categoryTypesFor(group: Group, terms: string[]): string[] {
  const hints = terms.map((t) => GROUP_TERM_TYPE_HINTS[group][t.toLowerCase()]);
  if (hints.some((h) => !h)) return GROUP_FALLBACK_TYPES[group];
  const union = new Set<string>();
  for (const h of hints) for (const t of h!) union.add(t);
  return Array.from(union);
}

// Union of place types for the category search, scoped to the chosen group +
// terms within it. If any selected term isn't in the hint map (a custom
// type), we can't be sure what it means, so we stay broad within the group
// rather than risk missing matches.
export function categoryTypesForGroup(group: Group, terms: string[]): string[] {
  return categoryTypesFor(group, terms);
}

// Which group(s) a place belongs to, based on Google's own classification —
// not on which group tab searched for it. A place with no overlap against
// any group's vocabulary returns []; callers should fall back to the group
// that found it rather than leave a lead group-less.
export function groupsForTypes(types: string[]): Group[] {
  const set = new Set(types);
  const matches: Group[] = [];
  for (const group of Object.keys(GROUP_FALLBACK_TYPES) as Group[]) {
    if (GROUP_FALLBACK_TYPES[group].some((t) => set.has(t))) matches.push(group);
  }
  return matches;
}

// {tip} placeholder options for the WhatsApp pitch, scoped per group — value
// is what's stored on the lead, label is shown in the picker, phrase is the
// Romanian noun phrase (with article) slotted into "Am observat {tip}
// dumneavoastră".
export type PitchOption = { value: string; label: string; phrase: string };

export const GROUP_PITCH_OPTIONS: Record<Group, PitchOption[]> = {
  turism: [
    { value: "pensiune", label: "Pensiune", phrase: "pensiunea" },
    { value: "cabana", label: "Cabană", phrase: "cabana" },
    { value: "chalet", label: "Chalet", phrase: "chalet-ul" },
    { value: "hotel", label: "Hotel", phrase: "hotelul" },
  ],
  restaurante: [
    { value: "restaurant", label: "Restaurant", phrase: "restaurantul" },
    { value: "cafenea", label: "Cafenea", phrase: "cafeneaua" },
    { value: "bar", label: "Bar/Pub", phrase: "barul" },
    { value: "pizzerie", label: "Pizzerie", phrase: "pizzeria" },
    { value: "patiserie", label: "Patiserie/Cofetărie", phrase: "patiseria" },
  ],
  evenimente: [
    { value: "sala_evenimente", label: "Sală de evenimente", phrase: "sala de evenimente" },
    { value: "salon_nunti", label: "Salon de nunți", phrase: "salonul de nunți" },
    { value: "club", label: "Club", phrase: "clubul" },
    { value: "bowling", label: "Bowling/Sală de jocuri", phrase: "sala de jocuri" },
    { value: "cazinou", label: "Cazinou", phrase: "cazinoul" },
    { value: "loc_joaca", label: "Loc de joacă", phrase: "locul de joacă" },
    { value: "parc_distractii", label: "Parc de distracții/acvatic", phrase: "parcul de distracții" },
  ],
  constructii: [
    { value: "constructor", label: "Firmă de construcții", phrase: "firma de construcții" },
    { value: "electrician", label: "Electrician", phrase: "firma de electricitate" },
    { value: "instalator", label: "Instalator", phrase: "firma de instalații" },
    { value: "zugrav", label: "Zugrav", phrase: "firma de zugrăveli" },
    { value: "acoperisuri", label: "Firmă acoperișuri", phrase: "firma de acoperișuri" },
  ],
  beauty: [
    { value: "salon_infrumusetare", label: "Salon de înfrumusețare", phrase: "salonul" },
    { value: "frizerie", label: "Frizerie/Coafor", phrase: "salonul" },
    { value: "manichiura", label: "Salon manichiură", phrase: "salonul" },
    { value: "spa", label: "Spa", phrase: "spa-ul" },
    { value: "masaj", label: "Salon masaj", phrase: "salonul de masaj" },
  ],
};

export const GROUP_DEFAULT_PITCH: Record<Group, string> = {
  turism: "pensiune",
  restaurante: "restaurant",
  evenimente: "sala_evenimente",
  constructii: "constructor",
  beauty: "salon_infrumusetare",
};

// Looks up the {tip} phrase for a (group, pitchType) pair, falling back to
// the group's default phrase if the stored value doesn't belong to this
// group's option list — happens when a cross-listed lead (see
// Lead.groups) is contacted from a group other than the one its pitchType
// was originally picked under.
export function pitchPhraseFor(group: Group, pitchType?: string): string {
  const options = GROUP_PITCH_OPTIONS[group];
  const match = options.find((o) => o.value === pitchType);
  if (match) return match.phrase;
  const fallback = options.find((o) => o.value === GROUP_DEFAULT_PITCH[group]);
  return fallback?.phrase ?? options[0].phrase;
}

const TOURISM_TEMPLATE_BODY =
  "deoarece realizez site-uri pentru pensiuni și cabane.\n\nRecent am finalizat câteva proiecte similare chiar in Jina, și cred că un site propriu poate fi util pentru prezentarea locației și o vizibilitate mai buna.\n\nDacă vă interesează, vă pot trimite câteva exemple de site-uri realizate de mine.";

function template(pitchLine: string): string {
  return `Bună ziua!\n\nMă numesc {eu} și sunt dezvoltator web. Am observat {tip} dumneavoastră ({nume}) și m-am gândit să vă contactez ${pitchLine}\n\nRecent am finalizat câteva proiecte similare chiar in Jina, și cred că un site propriu poate fi util pentru prezentarea locației și o vizibilitate mai buna.\n\nDacă vă interesează, vă pot trimite câteva exemple de site-uri realizate de mine.`;
}

// Default WhatsApp message per group — only the "deoarece..." clause changes
// to match the vertical; same starting point as today's single template, so
// the Turism default is byte-for-byte what it was before this feature.
export const GROUP_DEFAULT_TEMPLATE: Record<Group, string> = {
  turism: `Bună ziua!\n\nMă numesc {eu} și sunt dezvoltator web. Am observat {tip} dumneavoastră ({nume}) și m-am gândit să vă contactez ${TOURISM_TEMPLATE_BODY}`,
  restaurante: template("deoarece realizez site-uri pentru restaurante și cafenele."),
  evenimente: template("deoarece realizez site-uri pentru săli de evenimente și locații de divertisment."),
  constructii: template("deoarece realizez site-uri pentru firme de construcții și amenajări."),
  beauty: template("deoarece realizez site-uri pentru saloane de înfrumusețare și wellness."),
};

const STORAGE_KEY = "lf_group";

export function getStoredGroup(): Group {
  if (typeof window === "undefined") return "turism";
  const v = localStorage.getItem(STORAGE_KEY);
  return (v && (Object.keys(GROUP_TERMS) as Group[]).includes(v as Group) ? v : "turism") as Group;
}

export function setStoredGroup(group: Group) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, group);
}
