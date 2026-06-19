// Proxies a Google Place photo so the API key stays on the server.
//   GET /api/photo?name=places/<id>/photos/<ref>&w=400
// NOTE: each call is a billable Places "Photo" request, so the UI only loads
// photos lazily (when a card is expanded) and caps how many it shows.

const MEDIA_BASE = "https://places.googleapis.com/v1";

export async function GET(req: Request) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return new Response("Missing API key", { status: 500 });

  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name") || "";
  const width = Math.min(Math.max(Number(searchParams.get("w")) || 400, 100), 1200);

  // Only allow well-formed Place photo resource names — prevents this route
  // from being used to fetch arbitrary URLs.
  if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name)) {
    return new Response("Invalid photo name", { status: 400 });
  }

  const url = `${MEDIA_BASE}/${name}/media?maxWidthPx=${width}&key=${apiKey}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    return new Response("Photo fetch failed", { status: 502 });
  }

  const buf = await res.arrayBuffer();
  return new Response(buf, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
      // Cache hard so re-expanding the same card doesn't re-bill the photo.
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
