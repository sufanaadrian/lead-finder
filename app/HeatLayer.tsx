"use client";

// Shared heat-layer renderer for Leaflet maps — used by both the area picker
// (so you can see existing coverage while choosing where to search next) and
// the dashboard's coverage map, so the leaflet.heat wiring lives in one place.

import { useEffect } from "react";
import L from "leaflet";
import "leaflet.heat";
import { useMap } from "react-leaflet";

export type HeatPoint = { lat: number; lng: number };
export type AreaCircle = { lat: number; lng: number; radiusKm: number };
export type AreaRect = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export function HeatLayer({ points }: { points: HeatPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (L as any).heatLayer(
      points.map((p) => [p.lat, p.lng, 0.7]),
      { radius: 28, blur: 22, maxZoom: 12, gradient: { 0.3: "#22d3ee", 0.6: "#3b82f6", 1: "#a855f7" } }
    );
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, points]);
  return null;
}
