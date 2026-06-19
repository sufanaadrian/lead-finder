"use client";

// Free OpenStreetMap map (Leaflet) for picking a search area: click to drop a
// center point; the parent supplies the radius. No Google key, no map cost.
// Uses CircleMarker (vector) instead of a Marker, so no icon image assets are
// needed — avoids the classic Leaflet broken-marker-path issue with bundlers.

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Circle, CircleMarker, useMapEvents } from "react-leaflet";

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
}: {
  center: { lat: number; lng: number } | null;
  radiusKm: number;
  onPick: (lat: number, lng: number) => void;
}) {
  const initial: [number, number] = center ? [center.lat, center.lng] : [45.9, 25.0];
  const green = { color: "#10b981", fillColor: "#10b981" };

  return (
    <MapContainer
      center={initial}
      zoom={center ? 11 : 7}
      scrollWheelZoom
      className="w-full h-80 rounded-lg"
      style={{ height: "20rem" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
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
