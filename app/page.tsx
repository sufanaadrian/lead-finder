"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LeadStatus, SearchResult, StoredLead } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";

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

  function toggleType(t: string) {
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }
  function addCustomType() {
    const t = customType.trim().toLowerCase();
    if (t && !types.includes(t)) setTypes((cur) => [...cur, t]);
    setCustomType("");
  }

  const estRequests = types.length * pages;

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setWarning("");
    setLoading(true);
    setResults(null);
    setOverrides({});
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: types, location, pages }),
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
      if (hideKnown && l.known) return false;
      if (onlyNoWebsite && l.website) return false;
      if (requirePhone && !l.phone) return false;
      if (requireReviews && l.reviewCount <= 0) return false;
      if (requirePhotos && l.photoCount <= 0) return false;
      return true;
    });
  }, [results, hideKnown, onlyNoWebsite, requirePhone, requireReviews, requirePhotos]);

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

        <div className="grid sm:grid-cols-[1fr_1.3fr_auto] gap-3 mt-4">
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
              placeholder="ex: agroturism"
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30"
            />
          </Field>
          <Field label="Zona (oraș, județ, regiune)">
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Brașov / Valea Prahovei / Maramureș"
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30"
            />
          </Field>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={loading || types.length === 0}
              className="w-full sm:w-auto h-[46px] px-6 rounded-lg bg-emerald-500 text-black font-semibold hover:bg-emerald-400 disabled:opacity-50 transition-colors"
            >
              {loading ? "Caut…" : "Caută"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <span className="text-xs text-white/35 mr-1">Adâncime:</span>
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

      <div className="flex flex-wrap gap-2.5 mb-5">
        <Toggle on={hideKnown} onClick={() => setHideKnown((v) => !v)} label="Ascunde cele deja găsite" />
        <Toggle on={onlyNoWebsite} onClick={() => setOnlyNoWebsite((v) => !v)} label="Doar fără website" />
        <Toggle on={requirePhone} onClick={() => setRequirePhone((v) => !v)} label="Doar cu telefon" />
        <Toggle on={requireReviews} onClick={() => setRequireReviews((v) => !v)} label="Doar cu recenzii" />
        <Toggle on={requirePhotos} onClick={() => setRequirePhotos((v) => !v)} label="Doar cu poze" />
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
            onStatus={(s) => setOverrides((o) => ({ ...o, [l.id]: s }))}
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
  const [showTemplate, setShowTemplate] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/leads");
    const data = await res.json();
    setLeads(data.leads);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    return statusFilter === "all" ? leads : leads.filter((l) => l.status === statusFilter);
  }, [leads, statusFilter]);

  function exportCsv() {
    const rows = [
      ["Nume", "Telefon", "Adresă", "Status", "Recenzii", "Poze", "Website", "Notă", "Google Maps"],
      ...filtered.map((l) => [
        l.name, l.phone, l.address, STATUS_LABELS[l.status],
        String(l.reviewCount), String(l.photoCount), l.website || "—", l.note || "", l.mapsUri,
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
    const c: Record<string, number> = { all: leads?.length ?? 0 };
    for (const l of leads ?? []) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [leads]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex flex-wrap gap-2">
          <FilterPill active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
            Toate ({counts.all ?? 0})
          </FilterPill>
          {(["new", "contacted", "client", "skip"] as LeadStatus[]).map((s) => (
            <FilterPill key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
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

      <div className="flex flex-col gap-2.5">
        {filtered.map((l) => (
          <LeadCard
            key={l.id}
            lead={l}
            known={false}
            template={template}
            onStatus={() => {
              load();
              onChanged();
            }}
          />
        ))}
      </div>

      {leads && filtered.length === 0 && (
        <p className="text-white/40 text-center py-12">Nimic aici încă. Caută în tab-ul „Căutare".</p>
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
        on ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300" : "border-white/10 text-white/45 hover:text-white/70"
      }`}
    >
      <span className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center text-[10px] ${on ? "bg-emerald-400 border-emerald-400 text-black" : "border-white/30"}`}>
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

function LeadCard({
  lead,
  known,
  template,
  onStatus,
}: {
  lead: { id: string; name: string; address: string; phone: string; whatsapp: string; website: string; rating: number; reviewCount: number; photoCount: number; mapsUri: string; status: LeadStatus; lat?: number; lng?: number };
  known: boolean;
  template: string;
  onStatus: (s: LeadStatus) => void;
}) {
  const [showMap, setShowMap] = useState(false);

  async function setStatus(status: LeadStatus) {
    onStatus(status);
    try {
      await fetch("/api/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, status }),
      });
    } catch {}
  }

  function openWhatsApp() {
    const text = encodeURIComponent(template.replaceAll("{nume}", lead.name));
    window.open(`https://wa.me/${lead.whatsapp}?text=${text}`, "_blank", "noopener,noreferrer");
    if (lead.status === "new") setStatus("contacted");
  }

  return (
    <div className={`bg-white/[0.03] border rounded-xl p-4 transition-colors ${showMap ? "border-white/25" : "border-white/10"}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
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
            {known && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50 border border-white/15">deja salvat</span>
            )}
          </div>
          <p className="text-sm text-white/45 truncate">{lead.address}</p>
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
            onClick={() => setShowMap((v) => !v)}
            className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
              showMap ? "bg-white/10 border-white/30 text-white" : "border-white/15 hover:bg-white/5"
            }`}
          >
            🗺 Hartă
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

      {showMap && (
        <div className="mt-3">
          <iframe
            title={`Hartă ${lead.name}`}
            src={mapEmbedSrc(lead)}
            loading="lazy"
            className="w-full h-64 rounded-lg border border-white/10"
            referrerPolicy="no-referrer-when-downgrade"
          />
          {lead.mapsUri && (
            <a
              href={lead.mapsUri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 text-xs text-sky-300 hover:underline"
            >
              Deschide în Google Maps ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
