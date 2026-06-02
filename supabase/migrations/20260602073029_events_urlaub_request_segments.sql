alter table team_kalender.events
  add column if not exists urlaub_request_id uuid
  references public.urlaub_requests(id) on delete set null;

create index if not exists events_urlaub_request_id_idx
  on team_kalender.events (urlaub_request_id)
  where urlaub_request_id is not null;

comment on column team_kalender.events.urlaub_request_id is
  'Links approved vacation calendar segments back to the source urlaub_requests row.';
