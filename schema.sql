-- Supabase (EU) – Tabelle + Realtime für ROOTS Team-Kalender
-- In SQL-Editor ausführen, danach: Settings → API → anon key in config.js

create table if not exists public.events (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  type text not null,
  start_date date not null,
  end_date date not null,
  note text,
  created_at timestamptz default now() not null,
  constraint events_type_check check (type in ('urlaub', 'krank', 'dienstreise', 'sonstiges'))
);

-- Phase 1: RLS bewusst aus (nur intern nutzen, anon key nicht öffentlich teilen)
alter table public.events disable row level security;

alter publication supabase_realtime add table public.events;

-- Optional: Replicas (falls DELETE-Events in Realtime fehlen)
-- alter table public.events replica identity full;
