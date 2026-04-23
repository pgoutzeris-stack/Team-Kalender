/**
 * ROOTS Team-Kalender – nur HTTP zur Edge Function (kein Supabase-Key im Browser).
 */
import { TEAM_KALENDER_API_URL } from "./config.js";

/**
 * @param {string} method
 * @param {string} [pathAndQuery] z. B. "" oder "?list=members" oder "?id=x&target=member"
 * @param {object | null} body
 */
async function apiJson(method, pathAndQuery, body) {
  const u = pathAndQuery
    ? `${TEAM_KALENDER_API_URL}${String(pathAndQuery).startsWith("?") ? pathAndQuery : `?${pathAndQuery}`}`
    : TEAM_KALENDER_API_URL;
  const r = await fetch(u, {
    method,
    headers: { "Content-Type": "application/json" },
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

/**
 * @returns {Promise<Array<{id:string,member_id:string,member_name:string|null,type:string,start_date:string,end_date:string,note:string|null,created_at:string}>>}
 */
export async function fetchAllEvents() {
  return (await apiJson("GET", "", null)) || [];
}

/**
 * @returns {Promise<Array<{id:string,name:string,created_at:string}>>}
 */
export async function fetchMembers() {
  return (await apiJson("GET", "?list=members", null)) || [];
}

/**
 * @param {string} name
 * @returns {Promise<{id:string,name:string,created_at:string}>}
 */
export async function createMember(name) {
  return await apiJson("POST", "", { kind: "member", name });
}

/**
 * @param {string} id
 * @param {{ type: "event" | "member" }} [opts]
 */
export async function deleteById(id, opts) {
  const t = (opts && opts.type) || "event";
  const q =
    t === "member" ? `?id=${encodeURIComponent(id)}&target=member` : `?id=${encodeURIComponent(id)}`;
  return await apiJson("DELETE", q, null);
}

/** @param {string} id */
export function deleteEventById(id) {
  return deleteById(id, { type: "event" });
}

/** @param {string} id */
export function deleteMemberById(id) {
  return deleteById(id, { type: "member" });
}

/**
 * @param {{ member_id: string, type: string, start_date: string, end_date: string, note?: string | null }} row
 */
export async function insertEvent(row) {
  return await apiJson("POST", "", { kind: "event", ...row });
}

/**
 * @param {{ onData?: (p: { events: object[]; members: object[] }) => void, onStatus?: (s: "ok" | "err") => void }} h
 * @param {number} [intervalMs=4000]
 * @returns {() => void} stop
 */
export function startEventPolling(h, intervalMs = 4000) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const [events, members] = await Promise.all([fetchAllEvents(), fetchMembers()]);
      if (stopped) return;
      h.onData?.({ events, members });
      h.onStatus?.("ok");
    } catch {
      h.onStatus?.("err");
    }
  };
  const id = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
