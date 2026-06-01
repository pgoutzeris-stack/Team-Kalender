alter table team_kalender.events
  add column if not exists day_part text not null default 'full';

alter table team_kalender.events
  drop constraint if exists events_day_part_check;

alter table team_kalender.events
  add constraint events_day_part_check
  check (day_part in ('full', 'am', 'pm'));

alter table team_kalender.events
  drop constraint if exists events_half_day_single_date_check;

alter table team_kalender.events
  add constraint events_half_day_single_date_check
  check (day_part = 'full' or start_date = end_date);

comment on column team_kalender.events.day_part is
  'Ganztag oder Halbtag: full = ganztägig, am = vormittags, pm = nachmittags.';
