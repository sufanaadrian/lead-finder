"use client";

// Coverage heatmap (free, OpenStreetMap + Leaflet, no Google key):
//  - a heat layer over every place you've found (shows density / coverage)
//  - shaded shapes for the zones you actually searched:
//      • a circle for each "pick on map" area search (now also used for
//        geocoded typed-location searches, see app/api/search/route.ts)
//      • a rectangle for the rare fallback search with no resolved area

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Circle, Rectangle } from "react-leaflet";
import { HeatLayer, type HeatPoint, type AreaCircle, type AreaRect } from "./HeatLayer";
import { CountyLayer } from "./CountyLayer";

export type { HeatPoint, AreaCircle, AreaRect };

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
    <MapContainer center={center} zoom={all.length ? 8 : 7} scrollWheelZoom className="w-full h-[32rem] rounded-lg" style={{ height: "32rem" }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <CountyLayer />
      <HeatLayer points={points} />
      {circles.map((c, i) => (
        <Circle
          key={`c${i}`}
          center={[c.lat, c.lng]}
          radius={c.radiusKm * 1000}
          pathOptions={{ color: "#10b981", weight: 2, fillColor: "#10b981", fillOpacity: 0.15 }}
        />
      ))}
      {rects.map((r, i) => (
        <Rectangle
          key={`r${i}`}
          bounds={[
            [r.minLat, r.minLng],
            [r.maxLat, r.maxLng],
          ]}
          pathOptions={{ color: "#0ea5e9", weight: 2, fillColor: "#0ea5e9", fillOpacity: 0.12 }}
        />
      ))}
    </MapContainer>
  );
}
