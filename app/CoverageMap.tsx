"use client";

// Coverage heatmap (free, OpenStreetMap + Leaflet, no Google key):
//  - a heat layer over every place you've found (shows density / coverage)
//  - shaded shapes for the zones you actually searched:
//      • a circle for each "pick on map" area search
//      • a rectangle for each typed search, sized to its results' extent
//        (so searching a whole city shades roughly the whole city)

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import L from "leaflet";
import "leaflet.heat";
import { MapContainer, TileLayer, Circle, Rectangle, useMap } from "react-leaflet";

export type HeatPoint = { lat: number; lng: number };
export type AreaCircle = { lat: number; lng: number; radiusKm: number };
export type AreaRect = { minLat: number; maxLat: number; minLng: number; maxLng: number };

function HeatLayer({ points }: { points: HeatPoint[] }) {
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

export default function CoverageMap({
  points,
  circles,
  rects,
}: {
  points: HeatPoint[];
  circles: AreaCircle[];
  rects: AreaRect[];
}) {
  const all = [
    ...points,
    ...circles.map((c) => ({ lat: c.lat, lng: c.lng })),
    ...rects.map((r) => ({ lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 })),
  ];
  const center: [number, number] = all.length
    ? [all.reduce((s, p) => s + p.lat, 0) / all.length, all.reduce((s, p) => s + p.lng, 0) / all.length]
    : [45.9, 25.0];

  return (
    <MapContainer center={center} zoom={all.length ? 8 : 7} scrollWheelZoom className="w-full h-96 rounded-lg" style={{ height: "26rem" }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <HeatLayer points={points} />
      {circles.map((c, i) => (
        <Circle
          key={`c${i}`}
          center={[c.lat, c.lng]}
          radius={c.radiusKm * 1000}
          pathOptions={{ color: "#10b981", weight: 1, fillColor: "#10b981", fillOpacity: 0.08 }}
        />
      ))}
      {rects.map((r, i) => (
        <Rectangle
          key={`r${i}`}
          bounds={[
            [r.minLat, r.minLng],
            [r.maxLat, r.maxLng],
          ]}
          pathOptions={{ color: "#0ea5e9", weight: 1, fillColor: "#0ea5e9", fillOpacity: 0.06 }}
        />
      ))}
    </MapContainer>
  );
}
