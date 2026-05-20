ALTER TABLE team_kalender.events ADD COLUMN IF NOT EXISTS title text;

COMMENT ON COLUMN team_kalender.events.title IS 'Anzeigename im Kalender (Tag/Label)';
