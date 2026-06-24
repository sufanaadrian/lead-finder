"use client";

// Free OpenStreetMap map (Leaflet) for picking a search area: click to drop a
// center point; the parent supplies the radius. No Google key, no map cost.
// Uses CircleMarker (vector) instead of a Marker, so no icon image assets are
// needed — avoids the classic Leaflet broken-marker-path issue with bundlers.
//
// Also shows the coverage heatmap + past search zones (same data as the
// dashboard's coverage map) so you can see where you've already searched
// while picking the next area, instead of overlapping past work blindly.

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Circle, CircleMarker, Rectangle, useMapEvents } from "react-leaflet";
import { HeatLayer, type HeatPoint, type AreaCircle, type AreaRect } from "./HeatLayer";
import { CountyLayer } from "./CountyLayer";

function ClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function AreaPicker({
  center,
  radiusKm,
  onPick,
  heatPoints = [],
  pastCircles = [],
  pastRects = [],
}: {
  center: { lat: number; lng: number } | null;
  radiusKm: number;
  onPick: (lat: number, lng: number) => void;
  heatPoints?: HeatPoint[];
  pastCircles?: AreaCircle[];
  pastRects?: AreaRect[];
}) {
  const initial: [number, number] = center ? [center.lat, center.lng] : [45.9, 25.0];
  const green = { color: "#10b981", fillColor: "#10b981" };

  return (
    <MapContainer
      center={initial}
      zoom={center ? 11 : 7}
      scrollWheelZoom
      className="w-full h-[clamp(28rem,72vh,46rem)] rounded-lg"
      style={{ height: "clamp(28rem,72vh,46rem)" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <CountyLayer />
      <HeatLayer points={heatPoints} />
      {pastCircles.map((c, i) => (
        <Circle
          key={`pc${i}`}
          center={[c.lat, c.lng]}
          radius={c.radiusKm * 1000}
          pathOptions={{ color: "#0ea5e9", weight: 2, fillColor: "#0ea5e9", fillOpacity: 0.12 }}
        />
      ))}
      {pastRects.map((r, i) => (
        <Rectangle
          key={`pr${i}`}
          bounds={[
            [r.minLat, r.minLng],
            [r.maxLat, r.maxLng],
          ]}
          pathOptions={{ color: "#0ea5e9", weight: 2, fillColor: "#0ea5e9", fillOpacity: 0.1 }}
        />
      ))}
      <ClickHandler onPick={onPick} />
      {center && (
        <>
          <Circle center={[center.lat, center.lng]} radius={radiusKm * 1000} pathOptions={{ ...green, fillOpacity: 0.12 }} />
          <CircleMarker center={[center.lat, center.lng]} radius={6} pathOptions={{ ...green, fillOpacity: 1 }} />
        </>
      )}
    </MapContainer>
  );
}
