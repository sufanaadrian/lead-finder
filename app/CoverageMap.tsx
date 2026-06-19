"use client";

// Read-only OpenStreetMap (Leaflet) showing the areas already searched, as
// circles. Free — no Google key, no cost.

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Circle } from "react-leaflet";

export type Coverage = { lat: number; lng: number; radiusKm: number; label: string };

export default function CoverageMap({ circles }: { circles: Coverage[] }) {
  // Center on the average of the circles, or Romania if none.
  const center: [number, number] = circles.length
    ? [
        circles.reduce((s, c) => s + c.lat, 0) / circles.length,
        circles.reduce((s, c) => s + c.lng, 0) / circles.length,
      ]
    : [45.9, 25.0];

  return (
    <MapContainer center={center} zoom={circles.length ? 8 : 7} scrollWheelZoom className="w-full h-96 rounded-lg" style={{ height: "24rem" }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {circles.map((c, i) => (
        <Circle
          key={i}
          center={[c.lat, c.lng]}
          radius={c.radiusKm * 1000}
          pathOptions={{ color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.1 }}
        />
      ))}
    </MapContainer>
  );
}
