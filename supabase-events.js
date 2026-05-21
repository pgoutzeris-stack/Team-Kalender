/**
 * ROOTS Team-Kalender – HTTP zur Edge Function (kein Anon-Key im Browser).
 */
import { TEAM_KALENDER_API_URL } from "./config.js";

/** @type {() => Promise<string|null>} */
let getAccessToken = async () => null;

/** @param {{ getAccessToken?: () => Promise<string|null> }} opts */
export function initTeamKalenderApi(opts = {}) {
  if (typeof opts.getAccessToken === "function") {
    getAccessToken = opts.getAccessToken;
  }
}

/**
 * @param {string} method
 * @param {string} [pathAndQuery] z. B. "" oder "?list=members"
 * @param {object | null} body
 */
async function apiJson(method, pathAndQuery, body) {
  const u = pathAndQuery
    ? `${TEAM_KALENDER_API_URL}${String(pathAndQuery).startsWith("?") ? pathAndQuery : `?${pathAndQuery}`}`
    : TEAM_KALENDER_API_URL;
  const headers = { "Content-Type": "application/json" };
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const r = await fetch(u, {
    method,
    headers,
    body:
      method === "GET" || method === "DELETE"
        ? undefined
        : body != null
          ? JSON.stringify(body)
          : undefined,
  });
  const t = await r.text();
  let j;
  try {
    j = t ? JSON.parse(t) : null;
  } catch {
    j = { error: t || r.statusText };
  }
  if (!r.ok) {
    const err = (j && j.error) || r.statusText || "Request failed";
    throw new Error(err);
  }
  return j;
}

/** @returns {Promise<Array>} */
export async function fetchAllEvents() {
  return (await apiJson("GET", "", null)) || [];
}

/** @returns {Promise<Array<{holiday_date:string,label:string}>>} */
export async function fetchNrwHolidays() {
  return (await apiJson("GET", "?list=nrw_holidays", null)) || [];
}

/**
 * @param {string} userId
 * @param {string} name
 * @returns {Promise<{id:string,name:string,user_id:string|null,created_at:string}>}
 */
export async function ensureMemberForUser(userId, name) {
  return await apiJson("POST", "", { kind: "ensure_member", user_id: userId, name });
}

/**
 * @param {{ member_id: string, type: string, start_date: string, end_date: string, note?: string | null, title?: string }} row
 */
export async function insertEvent(row) {
  return await apiJson("POST", "", { kind: "event", ...row });
}

/**
 * @param {string} id
 * @param {{ type: string, start_date: string, end_date: string, note?: string | null, title?: string }} row
 */
export async function updateEvent(id, row) {
  return await apiJson("POST", "", { kind: "event_update", id, ...row });
}

/** @param {string} id */
export function deleteEventById(id) {
  return apiJson("DELETE", `?id=${encodeURIComponent(id)}`, null);
}
