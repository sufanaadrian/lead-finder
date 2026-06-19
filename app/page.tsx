"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { LeadStatus, SearchResult, StoredLead } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";

// Leaflet touches `window` on import, so load the map only in the browser.
const AreaPicker = dynamic(() => import("./AreaPicker"), {
  ssr: false,
  loading: () => <div className="w-full h-80 rounded-lg bg-white/[0.03] border border-white/10 grid place-items-center text-white/30 text-sm">Se încarcă harta…</div>,
});

const TYPE_OPTIONS = [
  "pensiune",
  "cabană",
  "casă de vacanță",
  "hotel",
  "vilă",
  "motel",
  "hostel",
  "camping",
];

const DEPTHS = [
  { label: "Rapid (20)", pages: 1 },
  { label: "Mediu (40)", pages: 2 },
  { label: "Complet (60)", pages: 3 },
];

const DEFAULT_TEMPLATE =
  "Bună ziua! Am văzut {nume} pe Google și am observat că nu aveți încă un site web. Realizez site-uri pentru pensiuni și cabane și aș putea să vă fac unul frumos, rapid. V-ar interesa câteva detalii?";

// Soft warning threshold for daily API requests (the real cap is set in Google Cloud).
const DAILY_WARN = 80;

type Tab = "search" | "saved";

export default function Home() {
  const [tab, setTab] = useState<Tab>("search");
  const [usageToday, setUsageToday] = useState<number | null>(null);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);

  // Load the saved WhatsApp template once.
  useEffect(() => {
    const saved = localStorage.getItem("wa_template");
    if (saved) setTemplate(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem("wa_template", template);
  }, [template]);

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
    <main className="min-h-screen max-w-5xl mx-auto px-5 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Lead Finder</h1>
          <p className="text-white/50 mt-1">
            Pensiuni, cabane și hoteluri <strong className="text-white/70">fără website</strong> — gata de contactat.
          </p>
        </div>
        <UsageBadge usage={usageToday} />
      </header>

      <div className="flex gap-1 mb-6 bg-white/[0.03] border border-white/10 rounded-xl p-1 w-fit">
        <TabBtn active={tab === "search"} onClick={() => setTab("search")}>Căutare</TabBtn>
        <TabBtn active={tab === "saved"} onClick={() => setTab("saved")}>Salvate</TabBtn>
      </div>

      {tab === "search" ? (
        <SearchTab template={template} onUsage={setUsageToday} />
      ) : (
        <SavedTab template={template} setTemplate={setTemplate} onChanged={refreshUsage} />
      )}
    </main>
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

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
        active ? "bg-white/15 text-white" : "text-white/45 hover:text-white/70"
      }`}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- Search tab */

function SearchTab({ template, onUsage }: { template: string; onUsage: (n: number) => void }) {
  const [types, setTypes] = useState<string[]>(["pensiune"]);
  const [customType, setCustomType] = useState("");
  const [location, setLocation] = useState("");
  const [areaMode, setAreaMode] = useState<"text" | "map">("text");
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(10);
  const [pages, setPages] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [query, setQuery] = useState("");
  const [lastUsed, setLastUsed] = useState<number | null>(null);

  const [onlyNoWebsite, setOnlyNoWebsite] = useState(true);
  const [requirePhone, setRequirePhone] = useState(true);
  const [requireReviews, setRequireReviews] = useState(false);
  const [requirePhotos, setRequirePhotos] = useState(false);
  // On by default: never show places already in the database.
  const [hideKnown, setHideKnown] = useState(true);

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

  // In map mode we also run one category (Nearby) search.
  const estRequests = types.length * pages + (areaMode === "map" ? 1 : 0);

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
        setWarning(data.warning || "");
        onUsage(data.usageToday);
      }
    } catch (err) {
      setError(`Eroare de rețea: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    if (!results) return [];
    return results.filter((l) => {
      if (dismissed.has(l.id)) return false;
      if (hideKnown && l.known) return false;
      if (onlyNoWebsite && l.website) return false;
      if (requirePhone && !l.phone) return false;
      if (requireReviews && l.reviewCount <= 0) return false;
      if (requirePhotos && l.photoCount <= 0) return false;
      return true;
    });
  }, [results, dismissed, hideKnown, onlyNoWebsite, requirePhone, requireReviews, requirePhotos]);

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
            {TYPE_OPTIONS.map((t) => {
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
              .filter((t) => !TYPE_OPTIONS.includes(t))
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
              <AreaPicker center={center} radiusKm={radiusKm} onPick={(lat, lng) => setCenter({ lat, lng })} />
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <label className="text-xs text-white/40">Rază: <strong className="text-white/70">{radiusKm} km</strong></label>
                <input
                  type="range"
                  min={1}
                  max={40}
                  value={radiusKm}
                  onChange={(e) => setRadiusKm(Number(e.target.value))}
                  className="flex-1 min-w-40 accent-emerald-400"
                />
                <span className="text-xs text-white/35">
                  {center ? `Centru: ${center.lat.toFixed(3)}, ${center.lng.toFixed(3)}` : "Apasă pe hartă pentru a alege centrul"}
                </span>
              </div>
              <p className="text-[11px] text-white/30 mt-1.5">
                Pe hartă căutăm și după categorie (tip Google: cazare), nu doar după cuvânt — prinde și locurile cu nume în engleză.
              </p>
            </div>
          )}
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
              title="Mai puține rezultate = mai puține cereri către Google"
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                pages === d.pages ? "bg-sky-500/20 border-sky-500/40 text-sky-200" : "border-white/10 text-white/50 hover:text-white/80"
              }`}
            >
              {d.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-white/35">
            ≈ <strong className="text-white/60">{estRequests}</strong> {estRequests === 1 ? "cerere" : "cereri"} către Google
          </span>
        </div>
      </form>

      <div className="mb-5">
        <p className="text-xs text-white/35 mb-2">Filtre (verde = activ):</p>
        <div className="flex flex-wrap gap-2.5">
          <Toggle on={hideKnown} onClick={() => setHideKnown((v) => !v)} label="Ascunde cele deja găsite" />
          <Toggle on={onlyNoWebsite} onClick={() => setOnlyNoWebsite((v) => !v)} label="Doar fără website" />
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
        <p className="text-sm text-white/50 mb-3">
          <strong className="text-white">{filtered.length}</strong> rezultate noi
          {hideKnown && hiddenKnown > 0 && <span className="text-white/30"> ({hiddenKnown} deja salvate, ascunse)</span>}
          {lastUsed !== null && <span className="text-white/30"> · {lastUsed} {lastUsed === 1 ? "cerere" : "cereri"} folosite</span>}
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {filtered.map((l) => (
          <LeadCard
            key={l.id}
            lead={{ ...l, status: overrides[l.id] ?? l.status }}
            known={l.known}
            template={template}
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
  template,
  setTemplate,
  onChanged,
}: {
  template: string;
  setTemplate: (t: string) => void;
  onChanged: () => void;
}) {
  const [leads, setLeads] = useState<StoredLead[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">("all");
  const [countyFilter, setCountyFilter] = useState<string>("all");
  const [localityFilter, setLocalityFilter] = useState<string>("all");
  const [interestedOnly, setInterestedOnly] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/leads");
    const data = await res.json();
    setLeads(data.leads);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Distinct counties, and localities within the chosen county, for the area filter.
  const counties = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads ?? []) if (l.county) set.add(l.county);
    return Array.from(set).sort();
  }, [leads]);

  const localities = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads ?? []) {
      if (!l.locality) continue;
      if (countyFilter !== "all" && l.county !== countyFilter) continue;
      set.add(l.locality);
    }
    return Array.from(set).sort();
  }, [leads, countyFilter]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
      if (statusFilter !== "all" && l.status !== statusFilter) return false;
      if (countyFilter !== "all" && l.county !== countyFilter) return false;
      if (localityFilter !== "all" && l.locality !== localityFilter) return false;
      if (interestedOnly && !l.interested) return false;
      return true;
    });
  }, [leads, statusFilter, countyFilter, localityFilter, interestedOnly]);

  function exportCsv() {
    const rows = [
      ["Nume", "Telefon", "Localitate", "Județ", "Adresă", "Status", "Interesat", "Recenzii", "Website", "Notă", "Google Maps"],
      ...filtered.map((l) => [
        l.name, l.phone, l.locality || "", l.county || "", l.address, STATUS_LABELS[l.status],
        l.interested ? "da" : "", String(l.reviewCount), l.website || "—", l.note || "", l.mapsUri,
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
    const c: Record<string, number> = { all: leads?.length ?? 0, interested: 0 };
    for (const l of leads ?? []) {
      c[l.status] = (c[l.status] ?? 0) + 1;
      if (l.interested) c.interested += 1;
    }
    return c;
  }, [leads]);

  return (
    <>
      {/* MAIN filter: location (county → locality) */}
      <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 mb-4">
        <p className="text-xs text-white/40 mb-2">📍 Filtru pe zonă</p>
        <div className="flex flex-wrap gap-2 items-center">
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
      </div>

      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex flex-wrap gap-2">
          <FilterPill active={statusFilter === "all" && !interestedOnly} onClick={() => { setStatusFilter("all"); setInterestedOnly(false); }}>
            Toate ({counts.all ?? 0})
          </FilterPill>
          <FilterPill active={interestedOnly} onClick={() => { setInterestedOnly((v) => !v); }}>
            ★ De contactat ({counts.interested ?? 0})
          </FilterPill>
          {(["new", "contacted", "client", "skip"] as LeadStatus[]).map((s) => (
            <FilterPill key={s} active={statusFilter === s && !interestedOnly} onClick={() => { setStatusFilter(s); setInterestedOnly(false); }}>
              {STATUS_LABELS[s]} ({counts[s] ?? 0})
            </FilterPill>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowTemplate((v) => !v)} className="text-sm px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5 transition-colors">
            ✏️ Mesaj WhatsApp
          </button>
          {filtered.length > 0 && (
            <button onClick={exportCsv} className="text-sm px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5 transition-colors">
              ⬇ Export CSV
            </button>
          )}
        </div>
      </div>

      {showTemplate && (
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 mb-4">
          <label className="block text-xs text-white/40 mb-1.5">
            Mesajul trimis pe WhatsApp. Folosește <code className="text-emerald-300">{"{nume}"}</code> pentru numele afacerii.
          </label>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={4}
            className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30 text-sm resize-none"
          />
        </div>
      )}

      <p className="text-sm text-white/40 mb-3">{filtered.length} {filtered.length === 1 ? "rezultat" : "rezultate"}</p>

      <div className="flex flex-col gap-2.5">
        {filtered.map((l) => (
          <LeadCard
            key={l.id}
            lead={l}
            known={false}
            template={template}
            onStatus={() => { load(); onChanged(); }}
            onInterested={() => { load(); }}
          />
        ))}
      </div>

      {leads && filtered.length === 0 && (
        <p className="text-white/40 text-center py-12">Nimic aici cu filtrele curente.</p>
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
  interested?: boolean;
};

function LeadCard({
  lead,
  known,
  template,
  onStatus,
  onInterested,
}: {
  lead: CardLead;
  known: boolean;
  template: string;
  onStatus: (s: LeadStatus) => void;
  onInterested?: (v: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [interested, setInterested] = useState(!!lead.interested);

  async function patch(body: Record<string, unknown>) {
    try {
      await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, ...body }),
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

  function openWhatsApp() {
    const text = encodeURIComponent(template.replaceAll("{nume}", lead.name));
    // Open the native WhatsApp app directly (no web tab). On a Mac with the
    // app installed this jumps straight into the chat.
    window.location.href = `whatsapp://send?phone=${lead.whatsapp}&text=${text}`;
    if (lead.status === "new") setStatus("contacted");
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
            </span>
            {lead.website ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">are website</span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">fără website</span>
            )}
            {lead.typeLabel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/55 border border-white/15">{lead.typeLabel}</span>
            )}
            {known && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50 border border-white/15">deja salvat</span>
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
          {lead.whatsapp && (
            <button onClick={openWhatsApp} className="px-3 py-2 rounded-lg bg-emerald-500 text-black text-sm font-medium hover:bg-emerald-400 transition-colors">
              WhatsApp
            </button>
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

      {expanded && (
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
