"use client";

import { useMemo, useState } from "react";
import type { Lead } from "./api/search/route";

const TERM_CHIPS = ["pensiune", "cabană", "hotel", "vilă", "casă de vacanță"];

export default function Home() {
  const [term, setTerm] = useState("pensiune");
  const [location, setLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [query, setQuery] = useState("");

  // Filter toggles — applied client-side so they update instantly.
  const [onlyNoWebsite, setOnlyNoWebsite] = useState(true);
  const [requireReviews, setRequireReviews] = useState(false);
  const [requirePhotos, setRequirePhotos] = useState(false);
  const [requirePhone, setRequirePhone] = useState(true);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    setLeads(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term, location }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "A apărut o eroare.");
      } else {
        setLeads(data.leads);
        setQuery(data.query);
      }
    } catch (err) {
      setError(`Eroare de rețea: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    if (!leads) return [];
    return leads.filter((l) => {
      if (onlyNoWebsite && l.website) return false;
      if (requireReviews && l.reviewCount <= 0) return false;
      if (requirePhotos && l.photoCount <= 0) return false;
      if (requirePhone && !l.phone) return false;
      return true;
    });
  }, [leads, onlyNoWebsite, requireReviews, requirePhotos, requirePhone]);

  function exportCsv() {
    const rows = [
      ["Nume", "Telefon", "Adresă", "Recenzii", "Poze", "Website", "Google Maps"],
      ...filtered.map((l) => [
        l.name,
        l.phone,
        l.address,
        String(l.reviewCount),
        String(l.photoCount),
        l.website || "—",
        l.mapsUri,
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${location || "export"}.csv`.replace(/\s+/g, "-").toLowerCase();
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-5 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Lead Finder</h1>
        <p className="text-white/50 mt-1">
          Găsește pensiuni, cabane și hoteluri <strong className="text-white/70">fără website</strong> — gata de contactat pe WhatsApp.
        </p>
      </header>

      {/* Search form */}
      <form onSubmit={search} className="bg-white/[0.03] border border-white/10 rounded-2xl p-5 mb-6">
        <div className="grid sm:grid-cols-[1fr_1.3fr_auto] gap-3">
          <div>
            <label className="block text-xs text-white/40 mb-1.5">Ce caut</label>
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="pensiune"
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30"
            />
          </div>
          <div>
            <label className="block text-xs text-white/40 mb-1.5">Zona (oraș, județ, regiune)</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Brașov / Valea Prahovei / Maramureș"
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 outline-none focus:border-white/30"
            />
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={loading}
              className="w-full sm:w-auto h-[46px] px-6 rounded-lg bg-emerald-500 text-black font-semibold hover:bg-emerald-400 disabled:opacity-50 transition-colors"
            >
              {loading ? "Caut…" : "Caută"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-3">
          {TERM_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setTerm(c)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                term === c
                  ? "bg-white/15 border-white/30 text-white"
                  : "border-white/10 text-white/50 hover:text-white/80"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap gap-2.5 mb-6">
        <Toggle on={onlyNoWebsite} onClick={() => setOnlyNoWebsite((v) => !v)} label="Doar fără website" />
        <Toggle on={requirePhone} onClick={() => setRequirePhone((v) => !v)} label="Doar cu telefon" />
        <Toggle on={requireReviews} onClick={() => setRequireReviews((v) => !v)} label="Doar cu recenzii" />
        <Toggle on={requirePhotos} onClick={() => setRequirePhotos((v) => !v)} label="Doar cu poze" />
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-xl px-4 py-3 mb-6 text-sm">
          {error}
        </div>
      )}

      {leads && (
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-white/50">
            <strong className="text-white">{filtered.length}</strong> rezultate
            {leads.length !== filtered.length && (
              <span className="text-white/30"> (din {leads.length} găsite pentru „{query}”)</span>
            )}
          </p>
          {filtered.length > 0 && (
            <button
              onClick={exportCsv}
              className="text-sm px-4 py-2 rounded-lg border border-white/15 hover:bg-white/5 transition-colors"
            >
              ⬇ Export CSV
            </button>
          )}
        </div>
      )}

      {/* Results */}
      <div className="flex flex-col gap-2.5">
        {filtered.map((l) => (
          <LeadCard key={l.id} lead={l} />
        ))}
      </div>

      {leads && filtered.length === 0 && !error && (
        <p className="text-white/40 text-center py-12">
          Niciun rezultat cu filtrele curente. Încearcă să dezactivezi câteva filtre.
        </p>
      )}

      {!leads && !loading && !error && (
        <p className="text-white/30 text-center py-12">
          Introdu o zonă și apasă „Caută” pentru a începe.
        </p>
      )}
    </main>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 text-sm px-3.5 py-2 rounded-lg border transition-colors ${
        on
          ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
          : "border-white/10 text-white/45 hover:text-white/70"
      }`}
    >
      <span
        className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center text-[10px] ${
          on ? "bg-emerald-400 border-emerald-400 text-black" : "border-white/30"
        }`}
      >
        {on ? "✓" : ""}
      </span>
      {label}
    </button>
  );
}

function LeadCard({ lead }: { lead: Lead }) {
  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold truncate">{lead.name}</h3>
          {lead.website ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
              are website
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              fără website
            </span>
          )}
        </div>
        <p className="text-sm text-white/45 truncate">{lead.address}</p>
        <div className="flex items-center gap-3 text-xs text-white/40 mt-1">
          {lead.phone ? <span>📞 {lead.phone}</span> : <span className="text-white/25">fără telefon</span>}
          <span>⭐ {lead.rating || "—"} ({lead.reviewCount})</span>
          <span>🖼 {lead.photoCount}</span>
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        {lead.whatsapp && (
          <a
            href={`https://wa.me/${lead.whatsapp}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-2 rounded-lg bg-emerald-500 text-black text-sm font-medium hover:bg-emerald-400 transition-colors"
          >
            WhatsApp
          </a>
        )}
        {lead.mapsUri && (
          <a
            href={lead.mapsUri}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-2 rounded-lg border border-white/15 text-sm hover:bg-white/5 transition-colors"
          >
            Maps
          </a>
        )}
      </div>
    </div>
  );
}
