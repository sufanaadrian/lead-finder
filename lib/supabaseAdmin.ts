// Server-only Supabase client, used by lib/db.ts. The service role key
// bypasses Row Level Security entirely, so this must never be imported from
// client ("use client") code — only from API routes and scripts.
//
// Built lazily (not at module load) so `next build` doesn't fail just
// because env vars aren't set yet — it only matters once a request actually
// comes in, by which point Vercel/`.env.local` has provided them.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Lipsesc NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Vezi README.md → Setup."
    );
  }
  client = createClient(url, serviceKey, { auth: { persistSession: false } });
  return client;
}
