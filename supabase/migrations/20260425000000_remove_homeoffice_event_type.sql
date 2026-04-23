-- Ereignistyp homeoffice entfernen (UI + CHECK); bestehende Zeilen -> sonstiges

update public.events set type = 'sonstiges' where type = 'homeoffice';

alter table public.events drop constraint if exists events_type_check;

alter table public.events
  add constraint events_type_check check (
    type in ('urlaub', 'krank', 'dienstreise', 'sonstiges')
  );
