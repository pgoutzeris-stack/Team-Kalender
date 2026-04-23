-- Team-Kalender: Abwesenheits-Einträge + Realtime

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

alter table public.events disable row level security;

-- Realtime: Tabelle in Publication (idempotent: Fehler bei „bereits in publication“ im Dashboard prüfen)
do $$
begin
  alter publication supabase_realtime add table public.events;
exception
  when duplicate_object then null;
  when others then
    if sqlerrm not like '%already member%' and sqlerrm not like '%already%' then
      raise;
    end if;
end
$$;
