"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Group, LeadStatus, SearchRecord, SearchResult, StoredLead } from "@/lib/types";
import { DEFAULT_GROUP, GROUPS, GROUP_LABELS, STATUS_LABELS, scoreLead } from "@/lib/types";
import {
  GROUP_TERMS,
  GROUP_DEFAULT_TEMPLATE,
  GROUP_PITCH_OPTIONS,
  GROUP_DEFAULT_PITCH,
  pitchPhraseFor,
  getStoredGroup,
  setStoredGroup,
} from "@/lib/groups";
import { supabaseClient } from "@/lib/supabaseClient";
import { getActor, setActor, USERS } from "@/lib/identity";

// Leaflet touches `window` on import, so load the map only in the browser.
const AreaPicker = dynamic(() => import("./AreaPicker"), {
  ssr: false,
  loading: () => <div className="w-full h-[clamp(28rem,72vh,46rem)] rounded-lg bg-white/[0.03] border border-white/10 grid place-items-center text-white/30 text-sm">Se încarcă harta…</div>,
});
const CoverageMap = dynamic(() => import("./CoverageMap"), {
  ssr: false,
  loading: () => <div className="w-full h-[32rem] rounded-lg bg-white/[0.03] border border-white/10 grid place-items-center text-white/30 text-sm">Se încarcă harta…</div>,
});

// Sort options shared by Search results and the Saved list.
const SORTS = [
  { key: "score", label: "Recomandate" },
  { key: "reviews", label: "Recenzii" },
  { key: "recent", label: "Recent" },
  { key: "name", label: "Nume" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

function sortLeads<T extends { phone: string; rating: number; reviewCount: number; photoCount: number; name: string; savedAt?: string; contactedAt?: string }>(
  list: T[],
  key: SortKey
): T[] {
  const arr = [...list];
  switch (key) {
    case "reviews":
      return arr.sort((a, b) => b.reviewCount - a.reviewCount);
    case "name":
      return arr.sort((a, b) => a.name.localeCompare(b.name, "ro"));
    case "recent":
      // Most recently CONTACTED first when that's known (so "the last one I
      // reached out to" is on top); falls back to when it was first found.
      return arr.sort((a, b) => {
        const at = a.contactedAt || a.savedAt || "";
        const bt = b.contactedAt || b.savedAt || "";
        return at < bt ? 1 : at > bt ? -1 : 0;
      });
    case "score":
    default:
      return arr.sort((a, b) => scoreLead(b) - scoreLead(a));
  }
}

// Coverage data (heat points + searched zones) shared by the dashboard's
// coverage map and the live search map, so picking a new area shows where
// you've already looked.
function computeCoverage(leads: { lat?: number; lng?: number }[], searches: SearchRecord[]) {
  const points = leads
    .filter((l) => typeof l.lat === "number" && typeof l.lng === "number")
    .map((l) => ({ lat: l.lat as number, lng: l.lng as number }));
  const circles = searches.filter((s) => s.area).map((s) => ({ lat: s.area!.lat, lng: s.area!.lng, radiusKm: s.area!.radiusKm }));
  const rects = searches.filter((s) => !s.area && s.bounds).map((s) => s.bounds!);
  return { points, circles, rects };
}

// Opens the native WhatsApp app via the whatsapp:// scheme WITHOUT navigating
// the page away (an anchor click triggers the OS handler but leaves React
// state intact — important so the contact stepper can advance afterwards).
function openWhatsAppApp(phone: string, message: string) {
  const a = document.createElement("a");
  a.href = `whatsapp://send?phone=${phone}&text=${encodeURIComponent(message)}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Pages of 20 results per zonă (tile). Google hard-caps a single query at 3
// pages (60 results) — raising this past 3 wouldn't get more back. Coverage
// beyond that comes from tiling large areas into many small zones server-side
// (see app/api/search/route.ts), not from this number.
const DEPTHS = [
  { label: "Rapid", pages: 1 },
  { label: "Mediu", pages: 2 },
  { label: "Complet", pages: 3 },
];

// Fills {nume}, {tip} and {eu} in one place so every WhatsApp send/preview
// stays consistent. {tip} comes from the hand-picked pitchType, scoped to
// whichever group the message is being sent from (see pitchPhraseFor in
// lib/groups.ts) — guessing it from Google's place type turned out unreliable.
// {eu} comes from whoever is logged in (see lib/identity.ts), so the message
// signs itself correctly regardless of who's sending it.
function fillTemplate(template: string, lead: { name: string; pitchType?: string }, actor: string | undefined, group: Group): string {
  return template
    .replaceAll("{nume}", lead.name)
    .replaceAll("{tip}", pitchPhraseFor(group, lead.pitchType))
    .replaceAll("{eu}", actor || "Adrian");
}

// Soft warning threshold for daily API requests (the real cap is set in Google Cloud).
const DAILY_WARN = 80;

// How long a "claim" (someone opened WhatsApp for this lead) stays worth
// warning about — after this, assume they decided not to message after all.
const CLAIM_TTL_MIN = 15;

function isClaimFresh(iso?: string): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < CLAIM_TTL_MIN * 60_000;
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "acum câteva secunde";
  if (min === 1) return "acum 1 minut";
  return `acum ${min} minute`;
}

// Non-blocking heads-up shown when someone else recently opened WhatsApp for
// this lead — the actual "don't message the same person twice" safeguard.
function ClaimBanner({ claimedBy, claimedAt, actor }: { claimedBy?: string; claimedAt?: string; actor: string }) {
  if (!claimedBy || claimedBy === actor || !isClaimFresh(claimedAt)) return null;
  return (
    <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mt-2">
      ⚠️ {claimedBy} a deschis WhatsApp pentru acest lead {timeAgo(claimedAt)} — verifică înainte să trimiți și tu.
    </p>
  );
}

type Tab = "search" | "saved" | "dashboard";

export default function Home() {
  const [tab, setTab] = useState<Tab>("search");
  // Which business vertical is active — scopes search/saved/dashboard and the
  // WhatsApp template everywhere. Starts at the default (turism) on the
  // server/first paint, then hydrates from localStorage once mounted, same
  // pattern as the actor below.
  const [group, setGroupState] = useState<Group>(DEFAULT_GROUP);
  const [usageToday, setUsageToday] = useState<number | null>(null);
  const [template, setTemplate] = useState(GROUP_DEFAULT_TEMPLATE[DEFAULT_GROUP]);
  const [templateBy, setTemplateBy] = useState<string | undefined>();
  const [actor, setActorState] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setGroupState(getStoredGroup());
  }, []);
  function setGroup(g: Group) {
    setGroupState(g);
    setStoredGroup(g);
  }

  // The WhatsApp template is shared (app_settings table) so either of you
  // editing it updates the other live, instead of each keeping a local copy —
  // and it's scoped per group, so switching groups loads that group's own
  // saved template (or its built-in default if nobody's saved one yet).
  const loadTemplate = useCallback(async () => {
    try {
      const res = await fetch(`/api/settings?group=${group}`);
      const data = await res.json();
      setTemplate(data.template || GROUP_DEFAULT_TEMPLATE[group]);
      setTemplateBy(data.updatedBy);
    } catch {}
  }, [group]);
  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);
  useEffect(() => {
    const client = supabaseClient;
    if (!client) return;
    const channel = client
      .channel("settings-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => loadTemplate())
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [loadTemplate]);

  async function saveTemplate(value: string) {
    setTemplate(value);
    setTemplateBy(actor || undefined);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: value, group, actor: actor || undefined }),
      });
    } catch {}
  }

  // Who's using this browser — used to claim leads and attribute actions
  // (see lib/identity.ts). Separate from the app password; this is just a
  // name. Ask right away if nobody's picked one on this device yet.
  useEffect(() => {
    const a = getActor();
    setActorState(a);
    if (!a) setPickerOpen(true);
  }, []);
  function saveActor(name: string) {
    setActor(name);
    setActorState(name);
    setPickerOpen(false);
  }

  // Keep the usage counter fresh.
  const refreshUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/leads");
      const data = await res.json();
      setUsageToday(data.usageToday ?? 0);
    } catch {}
  }, []);
  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-5 py-6">
      <header className="mb-5 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-lg font-bold tracking-tight shrink-0">Lead Finder</h1>
          <p className="text-xs text-white/40 truncate hidden sm:block">
            {GROUP_LABELS[group]} fără website — gata de contactat.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ActorBadge actor={actor} onClick={() => setPickerOpen(true)} />
          <UsageBadge usage={usageToday} />
        </div>
      </header>

      <div className="flex gap-1.5 mb-5 overflow-x-auto pb-1">
        {GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => setGroup(g)}
            className={`shrink-0 text-sm px-3.5 py-2 rounded-xl border whitespace-nowrap transition-colors ${
              group === g ? "bg-emerald-500/20 border-emerald-400/60 text-emerald-200" : "border-white/10 text-white/50 hover:text-white/80"
            }`}
          >
            {GROUP_LABELS[g]}
          </button>
        ))}
      </div>

      <div className="flex gap-1 mb-6 bg-white/[0.03] border border-white/10 rounded-xl p-1">
        <TabBtn icon="🔍" active={tab === "search"} onClick={() => setTab("search")}>Căutare</TabBtn>
        <TabBtn icon="📋" active={tab === "saved"} onClick={() => setTab("saved")}>Salvate</TabBtn>
        <TabBtn icon="📊" active={tab === "dashboard"} onClick={() => setTab("dashboard")}>Tablou</TabBtn>
      </div>

      {tab === "search" && <SearchTab group={group} template={template} actor={actor} onUsage={setUsageToday} />}
      {tab === "saved" && (
        <SavedTab group={group} template={template} templateBy={templateBy} onSaveTemplate={saveTemplate} actor={actor} onChanged={refreshUsage} />
      )}
      {tab === "dashboard" && <Dashboard group={group} />}

      {pickerOpen && (
        <ActorPicker current={actor} onSelect={saveActor} onClose={actor ? () => setPickerOpen(false) : undefined} />
      )}
    </main>
  );
}

// Identity used to claim leads and attribute actions — picked once per
// browser from a fixed list (just the two of you), not a real login.
function ActorBadge({ actor, onClick }: { actor: string; onClick: () => void }) {
  if (!actor) return null;
  return (
    <button
      onClick={onClick}
      title="Schimbă utilizatorul (dacă folosești acest device împreună cu altcineva)"
      className="text-xs text-white/40 hover:text-white/70 bg-white/[0.03] border border-white/10 rounded-xl px-3 py-2"
    >
      👤 {actor}
    </button>
  );
}

// Big, hard-to-miss picker — shown automatically the first time the app
// loads on a device, and again via the "👤" badge to switch users.
function ActorPicker({ current, onSelect, onClose }: { current: string; onSelect: (name: string) => void; onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="bg-zinc-950 border border-white/15 rounded-2xl w-full max-w-sm p-8 text-center" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-semibold mb-1">Cine ești?</h2>
        <p className="text-sm text-white/40 mb-6">Alege un nume — îl folosim pentru mesaje și pentru a vedea cine a contactat pe cine.</p>
        <div className="flex flex-col gap-3">
          {USERS.map((name) => (
            <button
              key={name}
              onClick={() => onSelect(name)}
              className={`px-5 py-4 rounded-xl border text-lg font-medium transition-colors ${
                current === name
                  ? "bg-emerald-500/20 border-emerald-400/60 text-emerald-200"
                  : "border-white/15 text-white/80 hover:bg-white/5"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        {onClose && (
          <button onClick={onClose} className="mt-5 text-xs text-white/30 hover:text-white/60">
            Anulează
          </button>
        )}
      </div>
    </div>
  );
}

function UsageBadge({ usage }: { usage: number | null }) {
  if (usage === null) return null;
  const hot = usage >= DAILY_WARN;
  return (
    <div
      className={`text-right shrink-0 rounded-xl border px-3 py-2 ${
        hot ? "bg-amber-500/10 border-amber-500/40" : "bg-white/[0.03] border-white/10"
      }`}
      title="Câte cereri către Google ai folosit azi. Limita reală o setezi în Google Cloud."
    >
      <div className={`text-lg font-bold ${hot ? "text-amber-300" : "text-white"}`}>{usage}</div>
      <div className="text-[10px] text-white/40 uppercase tracking-wide">cereri azi</div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
        active ? "bg-white/15 text-white" : "text-white/45 hover:text-white/70"
      }`}
    >
      <span>{icon}</span>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- Search tab */

function SearchTab({
  group,
  template,
  actor,
  onUsage,
}: {
  group: Group;
  template: string;
  actor: string;
  onUsage: (n: number) => void;
}) {
  const [types, setTypes] = useState<string[]>([GROUP_TERMS[group][0]]);
  const [customType, setCustomType] = useState("");
  const [location, setLocation] = useState("");
  const [areaMode, setAreaMode] = useState<"text" | "map">("text");
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(10);
  // Pages per zonă (tile), not an overall cap — large areas are split into
  // many zones server-side, so total coverage isn't bounded by this number.
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [query, setQuery] = useState("");
  const [lastUsed, setLastUsed] = useState<number | null>(null);
  const [tilesUsed, setTilesUsed] = useState<number | null>(null);

  // Heatmap of everything found so far + zones already searched, shown live
  // on the area-picker map so you don't re-cover ground you've already done.
  const [coverage, setCoverage] = useState<{
    points: { lat: number; lng: number }[];
    circles: { lat: number; lng: number; radiusKm: number }[];
    rects: { minLat: number; maxLat: number; minLng: number; maxLng: number }[];
  }>({ points: [], circles: [], rects: [] });
  const loadCoverage = useCallback(async () => {
    try {
      const res = await fetch("/api/leads");
      const data = await res.json();
      const leads = (data.leads ?? []).filter((l: StoredLead) => l.groups.includes(group));
      const searches = (data.searches ?? []).filter((s: SearchRecord) => s.group === group);
      setCoverage(computeCoverage(leads, searches));
    } catch {}
  }, [group]);
  useEffect(() => {
    loadCoverage();
  }, [loadCoverage]);

  // Switching groups starts a fresh search: different vocabulary, different
  // results — keeping the old ones around would be confusing/wrong.
  useEffect(() => {
    setTypes([GROUP_TERMS[group][0]]);
    setResults(null);
    setQuery("");
  }, [group]);

  const [requirePhone, setRequirePhone] = useState(true);
  const [requireReviews, setRequireReviews] = useState(false);
  const [requirePhotos, setRequirePhotos] = useState(false);
  // On by default: never show places already in the database.
  const [hideKnown, setHideKnown] = useState(true);
  const [sort, setSort] = useState<SortKey>("score");

  // Per-row local status overrides so the badge updates instantly on action.
  const [overrides, setOverrides] = useState<Record<string, LeadStatus>>({});
  // Once a lead is handled (contacted/skip/client), drop it from the list so
  // you're always looking at what's left to do.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  function toggleType(t: string) {
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }
  function addCustomType() {
    const t = customType.trim().toLowerCase();
    if (t && !types.includes(t)) setTypes((cur) => [...cur, t]);
    setCustomType("");
  }

  // Minimum per zonă (tile): one category search plus each term's pages.
  // Large areas are split into multiple zones server-side, so the real total
  // (shown after the search as "cereri folosite") can be several times this.
  const estRequestsPerZone = types.length * pages + 1;

  const useMap = areaMode === "map";
  const canSearch = types.length > 0 && (useMap ? !!center : location.trim().length > 0);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!canSearch) {
      setError(useMap ? "Apasă pe hartă pentru a alege o zonă." : "Scrie o zonă.");
      return;
    }
    setError("");
    setWarning("");
    setLoading(true);
    setResults(null);
    setOverrides({});
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          terms: types,
          location: useMap ? "" : location,
          area: useMap && center ? { lat: center.lat, lng: center.lng, radiusKm } : undefined,
          pages,
          group,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "A apărut o eroare.");
        if (data.usageToday !== undefined) onUsage(data.usageToday);
      } else {
        setResults(data.results);
        setQuery(data.query);
        setLastUsed(data.requestsUsed);
        setTilesUsed(data.tilesUsed ?? null);
        setWarning(data.warning || "");
        onUsage(data.usageToday);
        loadCoverage(); // results were just saved — refresh the heatmap
      }
    } catch (err) {
      setError(`Eroare de rețea: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    if (!results) return [];
    const f = results.filter((l) => {
      if (dismissed.has(l.id)) return false;
      if (l.website) return false; // safety net — only no-website places
      if (hideKnown && l.known) return false;
      if (requirePhone && !l.phone) return false;
      if (requireReviews && l.reviewCount <= 0) return false;
      if (requirePhotos && l.photoCount <= 0) return false;
      return true;
    });
    return sortLeads(f, sort);
  }, [results, dismissed, hideKnown, requirePhone, requireReviews, requirePhotos, sort]);

  // Mark a lead handled and remove it from view (contacted/skip/client).
  function handleStatus(id: string, s: LeadStatus) {
    setOverrides((o) => ({ ...o, [id]: s }));
    if (s !== "new") setDismissed((d) => new Set(d).add(id));
  }

  const hiddenKnown = results ? results.filter((l) => l.known).length : 0;

  return (
    <>
      <form onSubmit={search} className="bg-white/[0.03] border border-white/10 rounded-2xl p-5 mb-5">
        {/* Property types — pick as many as you want */}
        <Field label="Ce tipuri caut (poți alege mai multe)">
          <div className="flex flex-wrap gap-2">
            {GROUP_TERMS[group].map((t) => {
              const on = types.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                    on ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-200" : "border-white/10 text-white/50 hover:text-white/80"
                  }`}
                >
                  {on ? "✓ " : ""}{t}
                </button>
              );
            })}
            {/* Custom types added by the user */}
            {types
              .filter((t) => !GROUP_TERMS[group].includes(t))
              .map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className="text-sm px-3 py-1.5 rounded-full border bg-emerald-500/20 border-emerald-500/50 text-emerald-200"
                >
                  ✓ {t} ✕
                </button>
              ))}
          </div>
        </Field>

        <div className="mt-3">
          <Field label="Adaugă tip propriu">
            <input
              value={customType}
              onChange={(e) => setCustomType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomType();
                }
              }}
              placeholder="ex: agroturism (apasă Enter)"
              className="w-full sm:max-w-xs bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30"
            />
          </Field>
        </div>

        {/* Zone: type it, or pick an area on the map */}
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-white/40">Zona:</span>
            <div className="flex gap-1 bg-black/30 border border-white/10 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setAreaMode("text")}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${areaMode === "text" ? "bg-white/15 text-white" : "text-white/45 hover:text-white/70"}`}
              >
                Scrie zona
              </button>
              <button
                type="button"
                onClick={() => setAreaMode("map")}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${areaMode === "map" ? "bg-white/15 text-white" : "text-white/45 hover:text-white/70"}`}
              >
                Alege pe hartă
              </button>
            </div>
          </div>

          {areaMode === "text" ? (
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Brașov / Valea Prahovei / Maramureș"
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30"
            />
          ) : (
            <div>
              <div className="relative">
                <AreaPicker
                  center={center}
                  radiusKm={radiusKm}
                  onPick={(lat, lng) => setCenter({ lat, lng })}
                  heatPoints={coverage.points}
                  pastCircles={coverage.circles}
                  pastRects={coverage.rects}
                />
                <div className="absolute top-3 right-3 z-[1000] w-48 bg-black/75 backdrop-blur border border-white/15 rounded-xl px-3 py-2.5 shadow-lg">
                  <label className="text-xs text-white/60 block mb-1.5">
                    Rază: <strong className="text-white">{radiusKm} km</strong>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={40}
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(Number(e.target.value))}
                    className="w-full accent-emerald-400"
                  />
                  <p className="text-[11px] text-white/40 mt-1.5">
                    {center ? `${center.lat.toFixed(3)}, ${center.lng.toFixed(3)}` : "Apasă pe hartă pentru centru"}
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-white/30 mt-1.5">
                Zonele colorate = locuri găsite deja (heatmap); cercurile albastre = zone căutate anterior.
              </p>
            </div>
          )}
          <p className="text-[11px] text-white/30 mt-1.5">
            Căutăm și după categorie Google, nu doar după cuvânt — prinde și locurile cu nume neobișnuit sau în engleză. Zonele mari sunt împărțite automat în zone mai mici, ca să nu rămânem blocați la limita Google de 60 de rezultate per cerere.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button
            type="submit"
            disabled={loading || !canSearch}
            className="h-[42px] px-6 rounded-lg bg-emerald-500 text-black font-semibold hover:bg-emerald-400 disabled:opacity-40 transition-colors"
          >
            {loading ? "Caut…" : "Caută"}
          </button>
          <span className="text-xs text-white/35 ml-2 mr-1">Adâncime:</span>
          {DEPTHS.map((d) => (
            <button
              key={d.pages}
              type="button"
              onClick={() => setPages(d.pages)}
              title="Pagini per zonă căutată — mai multe pagini = mai temeinic, dar mai multe cereri"
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                pages === d.pages ? "bg-sky-500/20 border-sky-500/40 text-sky-200" : "border-white/10 text-white/50 hover:text-white/80"
              }`}
            >
              {d.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-white/35" title="Zonele mari se împart automat în mai multe zone — totalul real apare după căutare.">
            ≈ <strong className="text-white/60">{estRequestsPerZone}</strong> {estRequestsPerZone === 1 ? "cerere" : "cereri"} / zonă
          </span>
        </div>
      </form>

      <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 mb-5">
        <p className="text-xs text-white/35 mb-2">
          Doar locuri <strong className="text-emerald-300/80">fără website</strong>. Filtre (verde = activ):
        </p>
        <div className="flex flex-wrap gap-2.5">
          <Toggle on={hideKnown} onClick={() => setHideKnown((v) => !v)} label="Ascunde cele deja găsite" />
          <Toggle on={requirePhone} onClick={() => setRequirePhone((v) => !v)} label="Doar cu telefon" />
          <Toggle on={requireReviews} onClick={() => setRequireReviews((v) => !v)} label="Doar cu recenzii" />
          <Toggle on={requirePhotos} onClick={() => setRequirePhotos((v) => !v)} label="Doar cu poze" />
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-xl px-4 py-3 mb-5 text-sm">{error}</div>
      )}
      {warning && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-xl px-4 py-3 mb-5 text-sm">
          Atenție: {warning}
        </div>
      )}

      {results && (
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <p className="text-sm text-white/50">
            <strong className="text-white">{filtered.length}</strong> rezultate noi
            {hideKnown && hiddenKnown > 0 && <span className="text-white/30"> ({hiddenKnown} deja salvate, ascunse)</span>}
            {lastUsed !== null && (
              <span className="text-white/30">
                {" "}
                · {lastUsed} {lastUsed === 1 ? "cerere" : "cereri"} folosite
                {tilesUsed !== null && tilesUsed > 1 ? ` în ${tilesUsed} zone` : ""}
              </span>
            )}
          </p>
          <SortSelect value={sort} onChange={setSort} />
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {filtered.map((l) => (
          <LeadCard
            key={l.id}
            lead={{ ...l, status: overrides[l.id] ?? l.status }}
            known={l.known}
            template={template}
            actor={actor}
            group={group}
            onStatus={(s) => handleStatus(l.id, s)}
          />
        ))}
      </div>

      {results && filtered.length === 0 && !error && (
        <p className="text-white/40 text-center py-12">
          {hiddenKnown > 0 && filtered.length === 0
            ? "Toate rezultatele erau deja salvate. Caută altă zonă sau alt tip."
            : "Niciun rezultat nou cu filtrele curente. Dezactivează câteva filtre."}
        </p>
      )}
      {!results && !loading && !error && (
        <p className="text-white/30 text-center py-12">Alege tipurile, scrie o zonă și apasă „Caută".</p>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- Saved tab */

function SavedTab({
  group,
  template,
  templateBy,
  onSaveTemplate,
  actor,
  onChanged,
}: {
  group: Group;
  template: string;
  templateBy?: string;
  onSaveTemplate: (t: string) => void;
  actor: string;
  onChanged: () => void;
}) {
  const [leads, setLeads] = useState<StoredLead[] | null>(null);
  // Local draft so typing doesn't hit the network on every keystroke — only
  // committed (via onSaveTemplate) on blur, same pattern as the lead notes.
  const [templateDraft, setTemplateDraft] = useState(template);
  useEffect(() => {
    setTemplateDraft(template);
  }, [template]);
  // Default to "new" — once a lead's contacted/skipped/a client, there's no
  // point seeing it again every time the page loads.
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">("new");
  const [countyFilter, setCountyFilter] = useState<string>("all");
  const [localityFilter, setLocalityFilter] = useState<string>("all");
  const [interestedOnly, setInterestedOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [requirePhone, setRequirePhone] = useState(true);
  const [requireReviews, setRequireReviews] = useState(false);
  const [requirePhotos, setRequirePhotos] = useState(false);
  const [sort, setSort] = useState<SortKey>("score");
  const [showTemplate, setShowTemplate] = useState(false);
  const [contactMode, setContactMode] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/leads");
    const data = await res.json();
    setLeads(data.leads);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Live updates: when she (or you, on another device) changes a lead's
  // status, refetch so neither of you messages the same person twice.
  useEffect(() => {
    const client = supabaseClient;
    if (!client) return;
    const channel = client
      .channel("leads-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => load())
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [load]);

  // Forces a re-render every 30s so claim banners' "acum X minute" stays
  // roughly accurate even when nobody's triggered a Realtime refetch.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Scopes the saved-leads view to whichever group is active. A lead can
  // belong to several groups (see groupsForTypes in lib/groups.ts), so the
  // same lead may legitimately show up here and in another group's list.
  const groupLeads = useMemo(() => (leads ?? []).filter((l) => l.groups.includes(group)), [leads, group]);

  // Distinct counties, and localities within the chosen county, for the area filter.
  const counties = useMemo(() => {
    const set = new Set<string>();
    for (const l of groupLeads) if (l.county) set.add(l.county);
    return Array.from(set).sort();
  }, [groupLeads]);

  const localities = useMemo(() => {
    const set = new Set<string>();
    for (const l of groupLeads) {
      if (!l.locality) continue;
      if (countyFilter !== "all" && l.county !== countyFilter) continue;
      set.add(l.locality);
    }
    return Array.from(set).sort();
  }, [groupLeads, countyFilter]);

  const filtered = useMemo(() => {
    const f = groupLeads.filter((l) => {
      if (statusFilter !== "all" && l.status !== statusFilter) return false;
      if (countyFilter !== "all" && l.county !== countyFilter) return false;
      if (localityFilter !== "all" && l.locality !== localityFilter) return false;
      if (interestedOnly && !l.interested) return false;
      if (mineOnly && l.assignedTo !== actor) return false;
      if (requirePhone && !l.phone) return false;
      if (requireReviews && l.reviewCount <= 0) return false;
      if (requirePhotos && l.photoCount <= 0) return false;
      return true;
    });
    return sortLeads(f, sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupLeads, statusFilter, countyFilter, localityFilter, interestedOnly, mineOnly, actor, requirePhone, requireReviews, requirePhotos, sort]);

  function exportCsv() {
    const rows = [
      ["Nume", "Telefon", "Localitate", "Județ", "Adresă", "Status", "Interesat", "Recenzii", "Website", "Notă", "Google Maps", "Grupuri"],
      ...filtered.map((l) => [
        l.name, l.phone, l.locality || "", l.county || "", l.address, STATUS_LABELS[l.status],
        l.interested ? "da" : "", String(l.reviewCount), l.website || "—", l.note || "", l.mapsUri,
        (l.groups || []).map((g) => GROUP_LABELS[g]).join("; "),
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads-salvate.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: groupLeads.length, interested: 0 };
    for (const l of groupLeads) {
      c[l.status] = (c[l.status] ?? 0) + 1;
      if (l.interested) c.interested += 1;
    }
    return c;
  }, [groupLeads]);

  return (
    <>
      {/* Filters: zone first (the main one), then quality toggles */}
      <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 mb-4">
        <p className="text-xs text-white/40 mb-2">📍 Zonă</p>
        <div className="flex flex-wrap gap-2 items-center mb-3.5 pb-3.5 border-b border-white/10">
          <select
            value={countyFilter}
            onChange={(e) => { setCountyFilter(e.target.value); setLocalityFilter("all"); }}
            className="px-3 py-2 rounded-lg border border-white/15 bg-black/40 text-sm text-white/80 outline-none"
          >
            <option value="all" className="bg-zinc-900">Toate județele</option>
            {counties.map((c) => <option key={c} value={c} className="bg-zinc-900">{c}</option>)}
          </select>
          <select
            value={localityFilter}
            onChange={(e) => setLocalityFilter(e.target.value)}
            className="px-3 py-2 rounded-lg border border-white/15 bg-black/40 text-sm text-white/80 outline-none"
          >
            <option value="all" className="bg-zinc-900">Toate localitățile</option>
            {localities.map((c) => <option key={c} value={c} className="bg-zinc-900">{c}</option>)}
          </select>
          {(countyFilter !== "all" || localityFilter !== "all") && (
            <button
              onClick={() => { setCountyFilter("all"); setLocalityFilter("all"); }}
              className="text-xs text-white/40 hover:text-white/70 px-2 py-2"
            >
              ✕ resetează zona
            </button>
          )}
        </div>
        <p className="text-xs text-white/35 mb-2">Calitate (verde = activ)</p>
        <div className="flex flex-wrap gap-2.5">
          <Toggle on={requirePhone} onClick={() => setRequirePhone((v) => !v)} label="Doar cu telefon" />
          <Toggle on={requireReviews} onClick={() => setRequireReviews((v) => !v)} label="Doar cu recenzii" />
          <Toggle on={requirePhotos} onClick={() => setRequirePhotos((v) => !v)} label="Doar cu poze" />
          {actor && <Toggle on={mineOnly} onClick={() => setMineOnly((v) => !v)} label="👤 Doar ale mele" />}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex flex-wrap gap-2">
          <FilterPill active={statusFilter === "all" && !interestedOnly} onClick={() => { setStatusFilter("all"); setInterestedOnly(false); }}>
            Toate ({counts.all ?? 0})
          </FilterPill>
          <FilterPill active={interestedOnly} onClick={() => setInterestedOnly((v) => !v)}>
            ★ De contactat ({counts.interested ?? 0})
          </FilterPill>
          {(["new", "contacted", "client", "skip"] as LeadStatus[]).map((s) => (
            <FilterPill
              key={s}
              active={statusFilter === s && !interestedOnly}
              onClick={() => {
                setStatusFilter(s);
                setInterestedOnly(false);
                // The contacted list is most useful chronologically — the
                // one you just reached out to should be on top.
                if (s === "contacted") setSort("recent");
              }}
            >
              {STATUS_LABELS[s]} ({counts[s] ?? 0})
            </FilterPill>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowTemplate((v) => !v)} className="text-sm px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5 transition-colors">
            ✏️ Mesaj
          </button>
          {filtered.length > 0 && (
            <button onClick={exportCsv} className="text-sm px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5 transition-colors">
              ⬇ CSV
            </button>
          )}
        </div>
      </div>

      {showTemplate && (
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 mb-4">
          <label className="block text-xs text-white/40 mb-1.5">
            Mesajul trimis pe WhatsApp — partajat între voi, salvat automat. Folosește{" "}
            <code className="text-emerald-300">{"{nume}"}</code> pentru numele afacerii,{" "}
            <code className="text-emerald-300">{"{tip}"}</code> pentru tipul ei (ex: „pensiunea", „cabana", „hotelul") și{" "}
            <code className="text-emerald-300">{"{eu}"}</code> pentru numele tău (completat automat după cine e logat).
            {templateBy && <span className="text-white/30"> Ultima modificare: {templateBy}.</span>}
          </label>
          <textarea
            value={templateDraft}
            onChange={(e) => setTemplateDraft(e.target.value)}
            onBlur={() => {
              if (templateDraft !== template) onSaveTemplate(templateDraft);
            }}
            rows={8}
            className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30 text-sm resize-none"
          />
          {(!templateDraft.includes("{nume}") || !templateDraft.includes("{tip}")) && (
            <p className="text-xs text-amber-300 mt-1.5">
              ⚠️ Lipsește {!templateDraft.includes("{nume}") && <code>{"{nume}"}</code>}
              {!templateDraft.includes("{nume}") && !templateDraft.includes("{tip}") && " și "}
              {!templateDraft.includes("{tip}") && <code>{"{tip}"}</code>} din mesaj — se va trimite neînlocuit.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-3">
          <p className="text-sm text-white/40">{filtered.length} {filtered.length === 1 ? "rezultat" : "rezultate"}</p>
          {filtered.length > 0 && (
            <button
              onClick={() => setContactMode(true)}
              className="text-sm px-3 py-1.5 rounded-lg bg-emerald-500/90 text-black font-medium hover:bg-emerald-400 transition-colors"
            >
              ▶ Mod contactare
            </button>
          )}
        </div>
        <SortSelect value={sort} onChange={setSort} />
      </div>

      <div className="flex flex-col gap-2.5">
        {filtered.map((l) => (
          <LeadCard
            key={l.id}
            lead={l}
            known={false}
            template={template}
            actor={actor}
            group={group}
            onStatus={() => { load(); onChanged(); }}
            onInterested={() => { load(); }}
            onRefresh={load}
            editableType
          />
        ))}
      </div>

      {leads && filtered.length === 0 && (
        <p className="text-white/40 text-center py-12">Nimic aici cu filtrele curente.</p>
      )}

      {contactMode && (
        <ContactStepper
          leads={filtered}
          template={template}
          actor={actor}
          group={group}
          onClose={() => { setContactMode(false); load(); onChanged(); }}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------- shared bits */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-white/40 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 text-sm px-3.5 py-2 rounded-lg border transition-colors ${
        on ? "bg-emerald-500/25 border-emerald-400/60 text-emerald-200 font-medium" : "border-white/10 text-white/40 hover:text-white/70"
      }`}
    >
      <span className={`w-4 h-4 rounded-[4px] border flex items-center justify-center text-[11px] ${on ? "bg-emerald-400 border-emerald-400 text-black" : "border-white/30"}`}>
        {on ? "✓" : ""}
      </span>
      {label}
    </button>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
        active ? "bg-white/15 border-white/30 text-white" : "border-white/10 text-white/45 hover:text-white/70"
      }`}
    >
      {children}
    </button>
  );
}

function SortSelect({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  return (
    <label className="text-xs text-white/40 flex items-center gap-2">
      Sortează:
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="px-2 py-1.5 rounded-lg border border-white/15 bg-black/40 text-sm text-white/80 outline-none"
      >
        {SORTS.map((s) => (
          <option key={s.key} value={s.key} className="bg-zinc-900">{s.label}</option>
        ))}
      </select>
    </label>
  );
}

// Which kind of place this is for the {tip} placeholder in the WhatsApp
// message — picked by hand per lead, options scoped to the active group
// (see GROUP_PITCH_OPTIONS in lib/groups.ts).
function PitchTypeSelect({ group, value, onChange }: { group: Group; value: string; onChange: (t: string) => void }) {
  const options = GROUP_PITCH_OPTIONS[group];
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2 py-2 rounded-lg border border-white/15 bg-black/40 text-sm text-white/70 outline-none hover:bg-white/5"
      title="Tipul folosit în mesaj ({tip})"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-zinc-900">{o.label}</option>
      ))}
    </select>
  );
}

const STATUS_STYLE: Record<LeadStatus, string> = {
  new: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  contacted: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  client: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  skip: "bg-white/5 text-white/40 border-white/15",
};

// Keyless Google Maps embed. Uses exact coordinates when we have them, else
// falls back to a name+address search. No API key needed (and none exposed).
function mapEmbedSrc(lead: { name: string; address: string; lat?: number; lng?: number }): string {
  if (typeof lead.lat === "number" && typeof lead.lng === "number") {
    return `https://maps.google.com/maps?q=${lead.lat},${lead.lng}&z=16&output=embed`;
  }
  return `https://maps.google.com/maps?q=${encodeURIComponent(`${lead.name} ${lead.address}`)}&z=15&output=embed`;
}

type CardLead = {
  id: string; name: string; address: string; phone: string; whatsapp: string; website: string;
  rating: number; reviewCount: number; photoCount: number; mapsUri: string; status: LeadStatus;
  lat?: number; lng?: number; locality?: string; county?: string; typeLabel?: string; primaryType?: string;
  interested?: boolean; pitchType?: string; note?: string; groups?: Group[];
  claimedBy?: string; claimedAt?: string; contactedBy?: string; noteBy?: string; assignedTo?: string;
};

function LeadCard({
  lead,
  known,
  template,
  actor,
  group,
  onStatus,
  onInterested,
  onRefresh,
  editableType = false,
}: {
  lead: CardLead;
  known: boolean;
  template: string;
  actor: string;
  group: Group;
  onStatus: (s: LeadStatus) => void;
  onInterested?: (v: boolean) => void;
  onRefresh?: () => void;
  editableType?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [interested, setInterested] = useState(!!lead.interested);
  const [pitchType, setPitchType] = useState<string>(lead.pitchType ?? GROUP_DEFAULT_PITCH[group]);
  const [note, setNote] = useState(lead.note ?? "");
  // After opening WhatsApp, ask before marking contacted — opening the app
  // doesn't mean the message actually got sent.
  const [confirmSend, setConfirmSend] = useState(false);

  async function patch(body: Record<string, unknown>) {
    try {
      await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, actor: actor || undefined, ...body }),
      });
    } catch {}
  }

  function setStatus(status: LeadStatus) {
    onStatus(status);
    patch({ status });
  }

  function toggleInterested() {
    const v = !interested;
    setInterested(v);
    onInterested?.(v);
    patch({ interested: v });
  }

  function changePitchType(t: string) {
    setPitchType(t);
    patch({ pitchType: t });
  }

  function saveNote() {
    if (note !== (lead.note ?? "")) {
      patch({ note });
      onRefresh?.();
    }
  }

  function toggleAssign() {
    patch({ assignedTo: lead.assignedTo === actor ? null : actor });
    onRefresh?.();
  }

  function openWhatsApp() {
    openWhatsAppApp(lead.whatsapp, fillTemplate(template, { name: lead.name, pitchType }, actor, group));
    if (actor) patch({ claim: true });
    // Opening the app isn't the same as sending — ask before marking it.
    if (lead.status === "new") setConfirmSend(true);
  }

  function markSent() {
    setStatus("contacted");
    setConfirmSend(false);
  }

  return (
    <div className={`bg-white/[0.03] border rounded-xl p-4 transition-colors ${expanded ? "border-white/25" : "border-white/10"}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <button
          onClick={toggleInterested}
          title={interested ? "Scoate din listă" : "Adaugă la lista de contactat"}
          className={`text-xl leading-none shrink-0 transition-colors ${interested ? "text-amber-400" : "text-white/20 hover:text-white/50"}`}
        >
          {interested ? "★" : "☆"}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold truncate">{lead.name}</h3>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[lead.status]}`}>
              {STATUS_LABELS[lead.status]}
              {lead.contactedBy && (lead.status === "contacted" || lead.status === "client") ? ` · ${lead.contactedBy}` : ""}
            </span>
            {lead.assignedTo && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/45 border border-white/15">
                👤 {lead.assignedTo}
              </span>
            )}
            {lead.typeLabel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/55 border border-white/15">{lead.typeLabel}</span>
            )}
            {known && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50 border border-white/15">deja salvat</span>
            )}
            {lead.groups && lead.groups.length > 1 && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
                title={lead.groups.map((g) => GROUP_LABELS[g]).join(", ")}
              >
                🔗 {lead.groups.length} categorii
              </span>
            )}
          </div>
          <p className="text-sm text-white/45 truncate">
            {lead.locality ? <span className="text-white/60">{lead.locality}</span> : null}
            {lead.locality ? " · " : ""}{lead.address}
          </p>
          <div className="flex items-center gap-3 text-xs text-white/40 mt-1">
            {lead.phone ? <span>📞 {lead.phone}</span> : <span className="text-white/25">fără telefon</span>}
            <span>⭐ {lead.rating || "—"} ({lead.reviewCount})</span>
            <span>🖼 {lead.photoCount}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          {editableType && <PitchTypeSelect group={group} value={pitchType} onChange={changePitchType} />}
          {editableType && actor && (
            <button
              onClick={toggleAssign}
              title={lead.assignedTo && lead.assignedTo !== actor ? `Alocat lui ${lead.assignedTo} — apasă pentru a-l aloca ție` : undefined}
              className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                lead.assignedTo === actor ? "bg-white/10 border-white/30 text-white" : "border-white/15 text-white/50 hover:bg-white/5"
              }`}
            >
              {lead.assignedTo === actor ? "✓ Alocat ție" : "Alocă-mi"}
            </button>
          )}
          {lead.whatsapp && (
            <button onClick={openWhatsApp} className="px-3 py-2 rounded-lg bg-emerald-500 text-black text-sm font-medium hover:bg-emerald-400 transition-colors">
              WhatsApp
            </button>
          )}
          {lead.mapsUri && (
            <a
              href={lead.mapsUri}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-lg border border-white/15 text-sm hover:bg-white/5 transition-colors"
            >
              Maps ↗
            </a>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
              expanded ? "bg-white/10 border-white/30 text-white" : "border-white/15 hover:bg-white/5"
            }`}
          >
            {expanded ? "Ascunde ▲" : "Detalii ▾"}
          </button>
          <select
            value={lead.status}
            onChange={(e) => setStatus(e.target.value as LeadStatus)}
            className="px-2 py-2 rounded-lg border border-white/15 bg-black/40 text-sm text-white/70 outline-none hover:bg-white/5"
            title="Schimbă statusul"
          >
            {(["new", "contacted", "client", "skip"] as LeadStatus[]).map((s) => (
              <option key={s} value={s} className="bg-zinc-900">{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
      </div>

      <ClaimBanner claimedBy={lead.claimedBy} claimedAt={lead.claimedAt} actor={actor} />

      {confirmSend && lead.status === "new" && (
        <div className="mt-3 flex items-center gap-2 flex-wrap text-sm bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          <span className="text-amber-200/90">Ai trimis mesajul?</span>
          <button onClick={markSent} className="px-2.5 py-1 rounded-md bg-emerald-500 text-black text-xs font-medium hover:bg-emerald-400">
            ✓ Da, marchează contactat
          </button>
          <button onClick={() => setConfirmSend(false)} className="px-2.5 py-1 rounded-md border border-white/15 text-xs text-white/60 hover:bg-white/5">
            Nu
          </button>
        </div>
      )}

      {expanded && (
        <>
        <div className="mt-4 pt-4 border-t border-white/10 grid md:grid-cols-2 gap-4">
          {/* Left: facts */}
          <div className="flex flex-col gap-3">
            <dl className="text-sm flex flex-col gap-1.5">
              <Detail label="Telefon">
                {lead.phone ? (
                  <a href={`tel:${lead.phone.replace(/\s/g, "")}`} className="text-sky-300 hover:underline">{lead.phone}</a>
                ) : (
                  <span className="text-white/30">—</span>
                )}
              </Detail>
              <Detail label="Website">
                {lead.website ? (
                  <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-amber-300 hover:underline break-all">{lead.website}</a>
                ) : (
                  <span className="text-emerald-300">nu are</span>
                )}
              </Detail>
              <Detail label="Tip">
                <span className="text-white/70">{lead.typeLabel || lead.primaryType || "—"}</span>
              </Detail>
              <Detail label="Recenzii">
                <span className="text-white/70">⭐ {lead.rating || "—"} · {lead.reviewCount} recenzii</span>
              </Detail>
              <Detail label="Localitate">
                <span className="text-white/70">{[lead.locality, lead.county].filter(Boolean).join(", ") || "—"}</span>
              </Detail>
              <Detail label="Adresă">
                <span className="text-white/70">{lead.address || "—"}</span>
              </Detail>
            </dl>
            {lead.mapsUri && (
              <a href={lead.mapsUri} target="_blank" rel="noopener noreferrer" className="text-sm text-sky-300 hover:underline">
                Vezi poze și detalii pe Google Maps ↗
              </a>
            )}
          </div>

          {/* Right: free keyless map */}
          <div className="flex flex-col">
            <iframe
              title={`Hartă ${lead.name}`}
              src={mapEmbedSrc(lead)}
              loading="lazy"
              className="w-full h-56 md:h-full min-h-56 rounded-lg border border-white/10"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-xs text-white/40 mb-1.5">
            Notă{lead.noteBy ? ` (ultima de ${lead.noteBy})` : ""}
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            rows={2}
            placeholder="ex: a răspuns, vrea ofertă pe email…"
            className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 outline-none focus:border-white/30 text-sm resize-none"
          />
        </div>
        </>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-white/35 w-20 shrink-0">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------ contact mode stepper */

function ContactStepper({
  leads,
  template,
  actor,
  group,
  onClose,
}: {
  leads: StoredLead[];
  template: string;
  actor: string;
  group: Group;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const lead = leads[i];
  const [pitchType, setPitchType] = useState<string>(lead?.pitchType ?? GROUP_DEFAULT_PITCH[group]);
  // Reset the picker to this lead's own saved type whenever we move to a new one.
  useEffect(() => {
    setPitchType(lead?.pitchType ?? GROUP_DEFAULT_PITCH[group]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id, group]);

  async function patch(body: Record<string, unknown>) {
    if (!lead) return;
    try {
      await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, actor: actor || undefined, ...body }),
      });
    } catch {}
  }

  function changePitchType(t: string) {
    setPitchType(t);
    patch({ pitchType: t });
  }

  function next() {
    setI((v) => v + 1);
  }

  function back() {
    setI((v) => Math.max(0, v - 1));
  }

  // Opening WhatsApp doesn't mean the message was actually sent, so it no
  // longer marks the lead contacted or advances on its own — "✓ Am trimis"
  // does that explicitly, once you're sure.
  function whatsapp() {
    if (!lead) return;
    openWhatsAppApp(lead.whatsapp, fillTemplate(template, { name: lead.name, pitchType }, actor, group));
    if (actor) patch({ claim: true });
  }

  function markSent() {
    patch({ status: "contacted" });
    next();
  }

  const done = i >= leads.length;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="bg-zinc-950 border border-white/15 rounded-2xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Mod contactare</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white text-sm">✕ Închide</button>
        </div>

        {done ? (
          <div className="text-center py-10">
            <p className="text-2xl mb-2">✅</p>
            <p className="text-white/70">Gata! Ai trecut prin toate cele {leads.length}.</p>
            <button onClick={onClose} className="mt-5 px-5 py-2 rounded-lg bg-emerald-500 text-black font-medium hover:bg-emerald-400">Înapoi la listă</button>
          </div>
        ) : (
          <>
            <p className="text-xs text-white/35 mb-3">{i + 1} din {leads.length}</p>
            <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 mb-4">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <h4 className="font-semibold text-lg">{lead.name}</h4>
                {lead.typeLabel && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/55 border border-white/15">{lead.typeLabel}</span>}
              </div>
              <p className="text-sm text-white/50">{[lead.locality, lead.county].filter(Boolean).join(", ")}</p>
              <div className="flex items-center gap-3 text-xs text-white/40 mt-2">
                {lead.phone ? <span>📞 {lead.phone}</span> : <span className="text-white/25">fără telefon</span>}
                <span>⭐ {lead.rating || "—"} ({lead.reviewCount})</span>
                {lead.mapsUri && <a href={lead.mapsUri} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:underline">Maps ↗</a>}
              </div>
              <ClaimBanner claimedBy={lead.claimedBy} claimedAt={lead.claimedAt} actor={actor} />
            </div>

            <div className="flex items-center gap-2 mb-1">
              <p className="text-xs text-white/35">Tip (pentru mesaj):</p>
              <PitchTypeSelect group={group} value={pitchType} onChange={changePitchType} />
            </div>
            <p className="text-xs text-white/35 mb-1">Mesaj care se va trimite:</p>
            <p className="text-sm text-white/60 bg-black/30 border border-white/10 rounded-lg p-3 mb-4 whitespace-pre-line">
              {fillTemplate(template, { name: lead.name, pitchType }, actor, group)}
            </p>

            <div className="flex gap-2 flex-wrap">
              {lead.whatsapp ? (
                <button onClick={whatsapp} className="flex-1 px-4 py-3 rounded-lg bg-emerald-500 text-black font-semibold hover:bg-emerald-400">
                  WhatsApp
                </button>
              ) : (
                <span className="flex-1 px-4 py-3 rounded-lg bg-white/5 text-white/30 text-center text-sm">fără număr</span>
              )}
              <button onClick={markSent} className="px-4 py-3 rounded-lg border border-emerald-500/40 text-emerald-300 text-sm font-medium hover:bg-emerald-500/10" title="Confirmă că ai trimis mesajul și treci la următorul">
                ✓ Am trimis →
              </button>
              <button onClick={() => { patch({ status: "skip" }); next(); }} className="px-4 py-3 rounded-lg border border-white/15 text-sm hover:bg-white/5" title="Ignoră">
                Ignoră
              </button>
              <button onClick={next} className="px-4 py-3 rounded-lg border border-white/15 text-sm hover:bg-white/5" title="Sari peste, fără schimbări">
                Sari →
              </button>
              {i > 0 && (
                <button onClick={back} className="px-4 py-3 rounded-lg border border-white/15 text-sm text-white/50 hover:bg-white/5" title="Înapoi la cel anterior">
                  ← Înapoi
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- dashboard */

function Dashboard({ group }: { group: Group }) {
  const [leads, setLeads] = useState<StoredLead[] | null>(null);
  const [searches, setSearches] = useState<SearchRecord[]>([]);
  const [missingGeo, setMissingGeo] = useState(0);
  const [enriching, setEnriching] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/leads");
    const data = await res.json();
    setLeads(data.leads ?? []);
    setSearches(data.searches ?? []);
    setMissingGeo(data.missingGeo ?? 0);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Fill județ/localitate for leads with coordinates, in batches, until done.
  async function enrich() {
    setEnriching(true);
    try {
      let remaining = 1;
      while (remaining > 0) {
        const res = await fetch("/api/enrich", { method: "POST" });
        const data = await res.json();
        remaining = data.remaining ?? 0;
        setMissingGeo(remaining);
        if (!data.processed) break; // nothing advanced — avoid an infinite loop
      }
      await load();
    } finally {
      setEnriching(false);
    }
  }

  // Scopes the dashboard to whichever group is active. `missingGeo` stays
  // global/unscoped on purpose — geocoding backfill isn't a per-group concern.
  const scopedLeads = useMemo(() => (leads ?? []).filter((l) => l.groups.includes(group)), [leads, group]);
  const scopedSearches = useMemo(() => searches.filter((s) => s.group === group), [searches, group]);

  const totals = useMemo(() => {
    const t = { all: 0, new: 0, contacted: 0, client: 0, skip: 0, interested: 0 };
    for (const l of scopedLeads) {
      t.all++;
      t[l.status]++;
      if (l.interested) t.interested++;
    }
    return t;
  }, [scopedLeads]);

  // Per-county breakdown.
  const byArea = useMemo(() => {
    const map = new Map<string, { found: number; contacted: number; client: number }>();
    for (const l of scopedLeads) {
      const key = l.county || "necunoscut";
      const e = map.get(key) ?? { found: 0, contacted: 0, client: 0 };
      e.found++;
      if (l.status === "contacted") e.contacted++;
      if (l.status === "client") e.client++;
      map.set(key, e);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].found - a[1].found);
  }, [scopedLeads]);

  // Same coverage data shown live on the search map — heatmap points (every
  // lead with coordinates) plus shaded searched zones.
  const { points, circles, rects } = useMemo(() => computeCoverage(scopedLeads, scopedSearches), [scopedLeads, scopedSearches]);
  const hasCoverage = points.length > 0 || circles.length > 0 || rects.length > 0;

  if (!leads) return <p className="text-white/30 text-center py-12">Se încarcă…</p>;

  return (
    <div className="flex flex-col gap-6">
      {/* Overall stats — every lead here is already website-free */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total (fără website)" value={totals.all} accent="emerald" />
        <Stat label="Noi (necontactate)" value={totals.new} />
        <Stat label="Contactate" value={totals.contacted} accent="sky" />
        <Stat label="Clienți" value={totals.client} accent="violet" />
      </div>

      {missingGeo > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-amber-200/90">
            {missingGeo} {missingGeo === 1 ? "lead nu are" : "leaduri nu au"} județ/localitate completate.
          </p>
          <button
            onClick={enrich}
            disabled={enriching}
            className="text-sm px-4 py-2 rounded-lg bg-amber-400/90 text-black font-medium hover:bg-amber-300 disabled:opacity-60"
          >
            {enriching ? `Se completează… (rămase: ${missingGeo})` : "Completează din hartă"}
          </button>
        </div>
      )}

      {/* Per-area stats */}
      <div>
        <h3 className="text-sm font-semibold text-white/70 mb-2">Pe județe</h3>
        {byArea.length === 0 ? (
          <p className="text-white/30 text-sm">Încă nimic.</p>
        ) : (
          <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-white/40 text-xs">
                <tr className="border-b border-white/10">
                  <th className="text-left font-normal px-4 py-2">Județ</th>
                  <th className="text-right font-normal px-4 py-2">Găsite</th>
                  <th className="text-right font-normal px-4 py-2">Contactate</th>
                  <th className="text-right font-normal px-4 py-2">Clienți</th>
                </tr>
              </thead>
              <tbody>
                {byArea.map(([county, e]) => (
                  <tr key={county} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2 text-white/80">{county}</td>
                    <td className="px-4 py-2 text-right text-white/60">{e.found}</td>
                    <td className="px-4 py-2 text-right text-sky-300">{e.contacted}</td>
                    <td className="px-4 py-2 text-right text-violet-300">{e.client}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Coverage heatmap */}
      <div>
        <h3 className="text-sm font-semibold text-white/70 mb-2">Acoperire — unde ai căutat deja</h3>
        {!hasCoverage ? (
          <p className="text-white/30 text-sm">Încă nimic de afișat. Fă câteva căutări întâi.</p>
        ) : (
          <>
            <CoverageMap points={points} circles={circles} rects={rects} />
            <p className="text-[11px] text-white/30 mt-1.5">
              Zonele colorate = locuri găsite (heatmap). Cercurile verzi = căutări pe hartă. Dreptunghiurile albastre = căutări scrise (aprox. zona orașului).
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "emerald" | "sky" | "violet" }) {
  const color = accent === "emerald" ? "text-emerald-300" : accent === "sky" ? "text-sky-300" : accent === "violet" ? "text-violet-300" : "text-white";
  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-white/40 mt-0.5">{label}</div>
    </div>
  );
}
