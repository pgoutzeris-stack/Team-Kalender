-- Teammitglieder + Events verknüpfen (member_id statt freiem Text)

create table if not exists public.team_members (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  created_at timestamptz default now() not null,
  constraint team_members_name_unique unique (name)
);

alter table public.team_members disable row level security;

insert into public.team_members (name) values
  ('Richard'),
  ('Manuel'),
  ('Rod'),
  ('Pano')
on conflict (name) do nothing;

-- events: member_id hinzufügen, von name übernehmen
alter table public.events add column if not exists member_id uuid references public.team_members(id) on delete restrict;

update public.events set name = coalesce(nullif(trim(name), ''), 'Unbekannt') where name is null or trim(name) = '';

insert into public.team_members (name)
select distinct e.name from public.events e
where not exists (select 1 from public.team_members t where t.name = e.name);

update public.events e
set member_id = t.id
from public.team_members t
where e.member_id is null and t.name = e.name;

alter table public.events drop column if exists name;

alter table public.events alter column member_id set not null;

do $$
begin
  alter publication supabase_realtime add table public.team_members;
exception
  when duplicate_object then null;
  when others then
    if sqlerrm not like '%already member%' and sqlerrm not like '%already%' then
      raise;
    end if;
end
$$;
