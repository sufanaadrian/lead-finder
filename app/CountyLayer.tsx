"use client";

// Romanian county (județ) borders, overlaid on the Leaflet maps so you can
// tell where one region ends and the next begins — CARTO/OSM tiles don't
// draw admin boundaries on their own. Outline only, no name labels: the
// basemap's own city/town labels already have a proper size hierarchy
// (bigger cities = bigger text), and a flat 42-label overlay on top just
// drowned those out instead of helping. Data is a local static asset
// (public/ro-counties.geojson, source: geoBoundaries.org, CC BY 4.0) so
// there's no extra API call or key involved.

import { useEffect, useState } from "react";
import { GeoJSON } from "react-leaflet";

let cached: GeoJSON.FeatureCollection | null = null;

export function CountyLayer() {
  const [data, setData] = useState<GeoJSON.FeatureCollection | null>(cached);

  useEffect(() => {
    if (cached) return;
    fetch("/ro-counties.geojson")
      .then((r) => r.json())
      .then((d) => {
        cached = d;
        setData(d);
      })
      .catch(() => {});
  }, []);

  if (!data) return null;

  return <GeoJSON data={data} style={() => ({ color: "#f59e0b", weight: 1, opacity: 0.4, fill: false, dashArray: "4 4" })} />;
}
