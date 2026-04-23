/**
 * ROOTS Team-Kalender – nur HTTP zur Edge Function (kein Supabase-Key im Browser).
 * Service Role liegt ausschließlich serverseitig in der Function.
 */
import { TEAM_KALENDER_API_URL } from "./config.js";

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
 * @returns {Promise<Array<{id:string,name:string,type:string,start_date:string,end_date:string,note:string|null,created_at:string}>>}
 */
export async function fetchAllEvents() {
  return (await apiJson("GET", "", null)) || [];
}

/**
 * @param {{ name: string, type: string, start_date: string, end_date: string, note?: string | null }} row
 */
export async function insertEvent(row) {
  return await apiJson("POST", "", row);
}

/**
 * @param {string} id
 */
export async function deleteEventById(id) {
  return await apiJson("DELETE", `?id=${encodeURIComponent(id)}`, null);
}

/**
 * Regelmäßig Daten holen (ersetzt Realtime; kein Anon-Key im Client).
 * @param {{ onData?: (rows: object[]) => void, onStatus?: (s: "ok" | "err") => void }} h
 * @param {number} [intervalMs=4000]
 * @returns {() => void} stop
 */
export function startEventPolling(h, intervalMs = 4000) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const rows = await fetchAllEvents();
      if (stopped) return;
      h.onData?.(rows);
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
