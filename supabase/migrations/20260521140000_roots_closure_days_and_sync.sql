-- ROOTS Betriebsferien + 24.12: Kalender-Einträge & Urlaubsabzug (siehe public.sync_roots_closures_for_user)

create table if not exists team_kalender.roots_closure_days (
  id uuid primary key default gen_random_uuid(),
  closure_date date not null,
  label text not null,
  deduct_days numeric(4,1) not null default 1 check (deduct_days >= 0),
  closure_kind text not null default 'betriebsferien'
    check (closure_kind in ('betriebsferien', 'roots_gift')),
  calendar_year int not null,
  constraint roots_closure_days_date_key unique (closure_date)
);

alter table team_kalender.roots_closure_days disable row level security;

create table if not exists public.roots_closure_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  closure_day_id uuid not null references team_kalender.roots_closure_days(id) on delete cascade,
  member_id uuid references team_kalender.team_members(id) on delete set null,
  event_id uuid references team_kalender.events(id) on delete set null,
  urlaub_request_id uuid references public.urlaub_requests(id) on delete set null,
  deducted_days numeric(4,1) not null default 0,
  created_at timestamptz not null default now(),
  constraint roots_closure_assignments_user_day_key unique (user_id, closure_day_id)
);

alter table public.roots_closure_assignments disable row level security;
