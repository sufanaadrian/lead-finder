-- Lead Finder schema. Run this once in the Supabase SQL editor (Dashboard →
-- SQL Editor → New query → paste → Run) on a fresh project before running
-- scripts/migrate-to-supabase.mjs.

create table if not exists leads (
  id text primary key,
  name text not null default '',
  address text not null default '',
  phone text not null default '',
  whatsapp text not null default '',
  website text not null default '',
  rating numeric not null default 0,
  review_count integer not null default 0,
  photo_count integer not null default 0,
  maps_uri text not null default '',
  lat double precision,
  lng double precision,
  locality text,
  county text,
  primary_type text,
  type_label text,
  status text not null default 'new',
  interested boolean not null default false,
  note text not null default '',
  saved_at timestamptz not null default now(),
  contacted_at timestamptz,
  first_query text not null default '',
  geo_tried boolean not null default false,
  pitch_type text,
  claimed_by text,
  claimed_at timestamptz,
  contacted_by text,
  note_by text,
  assigned_to text
);

create table if not exists usage_counters (
  day date primary key,
  count integer not null default 0
);

create table if not exists searches (
  id bigserial primary key,
  at timestamptz not null default now(),
  terms text[] not null default '{}',
  location text,
  area jsonb,
  bounds jsonb,
  found integer not null default 0
);

-- Shared key/value settings, edited from the app. First (only) use so far:
-- the WhatsApp message template, so both of you edit the same text instead
-- of each keeping a local copy.
create table if not exists app_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Row Level Security: the app's API routes use the service role key, which
-- always bypasses RLS, so they keep working unchanged. Browser code only
-- gets the public anon key (for the live Realtime subscriptions below), so
-- it needs explicit read-only policies on `leads` and `app_settings` — and
-- nothing on the other two tables, which the browser never touches directly.
alter table leads enable row level security;
alter table usage_counters enable row level security;
alter table searches enable row level security;
alter table app_settings enable row level security;

drop policy if exists "anon can read leads" on leads;
create policy "anon can read leads" on leads for select using (true);

drop policy if exists "anon can read app_settings" on app_settings;
create policy "anon can read app_settings" on app_settings for select using (true);

-- Publish changes on these tables so the browser can subscribe live (this is
-- what lets two people see each other's updates without polling). Guarded so
-- re-running this whole script doesn't error on "already a member".
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads'
  ) then
    alter publication supabase_realtime add table leads;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_settings'
  ) then
    alter publication supabase_realtime add table app_settings;
  end if;
end $$;

-- Bulk upsert used by /api/search: refreshes the scraped fields for leads
-- that already exist, but deliberately leaves status/interested/note/
-- saved_at/contacted_at/geo_tried/pitch_type untouched — those are ours, not
-- Google's, and a re-search must never clobber them.
create or replace function upsert_leads(payload jsonb)
returns void
language plpgsql
as $$
begin
  insert into leads (
    id, name, address, phone, whatsapp, website, rating, review_count,
    photo_count, maps_uri, lat, lng, locality, county, primary_type,
    type_label, first_query
  )
  select
    x->>'id', x->>'name', x->>'address', x->>'phone', x->>'whatsapp', x->>'website',
    coalesce((x->>'rating')::numeric, 0), coalesce((x->>'reviewCount')::int, 0),
    coalesce((x->>'photoCount')::int, 0), x->>'mapsUri',
    (x->>'lat')::double precision, (x->>'lng')::double precision,
    x->>'locality', x->>'county', x->>'primaryType', x->>'typeLabel', x->>'firstQuery'
  from jsonb_array_elements(payload) as x
  on conflict (id) do update set
    name = excluded.name,
    address = excluded.address,
    phone = excluded.phone,
    whatsapp = excluded.whatsapp,
    website = excluded.website,
    rating = excluded.rating,
    review_count = excluded.review_count,
    photo_count = excluded.photo_count,
    maps_uri = excluded.maps_uri,
    lat = excluded.lat,
    lng = excluded.lng,
    locality = excluded.locality,
    county = excluded.county,
    primary_type = excluded.primary_type,
    type_label = excluded.type_label;
end;
$$;

-- Leads still missing locality/county that we haven't tried to enrich yet
-- and that we CAN enrich (we have either coordinates or an address to
-- geocode) — mirrors lib/db.ts's old canEnrich() predicate exactly.
create or replace function get_leads_missing_geo(p_limit integer)
returns setof leads
language sql
stable
as $$
  select * from leads
  where geo_tried = false
    and (locality is null or locality = '' or county is null or county = '')
    and (
      (lat is not null and lng is not null)
      or (address is not null and address <> '')
    )
  limit p_limit;
$$;

create or replace function count_leads_missing_geo()
returns bigint
language sql
stable
as $$
  select count(*) from leads
  where geo_tried = false
    and (locality is null or locality = '' or county is null or county = '')
    and (
      (lat is not null and lng is not null)
      or (address is not null and address <> '')
    );
$$;
