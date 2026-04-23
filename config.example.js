/**
 * Kopiere nach config.js und setze deine Project-Ref / Function-Name.
 *
 * CORS: Die Edge Function erlaubt u. a. https://<user>.github.io (nur Host).
 * Eigene Domain: Secret TEAM_KALENDER_CORS_ORIGINS in Supabase setzen, siehe
 * supabase/functions/team-kalender/index.ts
 */
export const TEAM_KALENDER_API_URL =
  "https://<PROJECT_REF>.supabase.co/functions/v1/team-kalender";
