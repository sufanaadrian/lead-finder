-- Adds lead claiming, who-did-what attribution, and territory assignment to
-- an already-running project. Run once in the Supabase SQL Editor — safe to
-- re-run (IF NOT EXISTS). New projects get these columns directly from
-- supabase/schema.sql instead.
alter table leads add column if not exists claimed_by text;
alter table leads add column if not exists claimed_at timestamptz;
alter table leads add column if not exists contacted_by text;
alter table leads add column if not exists note_by text;
alter table leads add column if not exists assigned_to text;
