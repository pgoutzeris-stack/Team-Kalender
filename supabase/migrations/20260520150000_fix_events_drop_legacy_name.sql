-- Legacy-Spalte name blockierte Autosave-Inserts (NOT NULL ohne Wert).
UPDATE team_kalender.events e
SET member_id = t.id
FROM team_kalender.team_members t
WHERE e.member_id IS NULL AND t.name = e.name;

ALTER TABLE team_kalender.events DROP COLUMN IF EXISTS name;
ALTER TABLE team_kalender.events ALTER COLUMN member_id SET NOT NULL;
