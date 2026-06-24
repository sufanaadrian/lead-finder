// Browser-only Supabase client — uses the public anon key, which is safe to
// ship to the client (it can only read `leads`, per the RLS policy in
// supabase/schema.sql). Used for the live Realtime subscription so both
// people see each other's status changes without polling.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseClient =
  url && anonKey ? createClient(url, anonKey) : null;
