/**
 * ROOTS Team-Kalender – ausschließlich Supabase (Client, CRUD, Realtime).
 * Tabellen-Schema: public.events
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

let client = null;
let eventsChannel = null;

/**
 * @param {string} url
 * @param {string} anonKey
 * @returns {import("https://esm.sh/@supabase/supabase-js@2.49.0").SupabaseClient}
 */
export function createSupabaseClient(url, anonKey) {
  client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return client;
}

export function getSupabase() {
  return client;
}

/**
 * @returns {Promise<Array<{id:string,name:string,type:string,start_date:string,end_date:string,note:string|null,created_at:string}>>}
 */
export async function fetchAllEvents() {
  if (!client) throw new Error("Supabase nicht initialisiert");
  const { data, error } = await client
    .from("events")
    .select("id,name,type,start_date,end_date,note,created_at")
    .order("start_date", { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * @param {{ name: string, type: string, start_date: string, end_date: string, note?: string | null }} row
 * @returns {Promise<object>}
 */
export async function insertEvent(row) {
  if (!client) throw new Error("Supabase nicht initialisiert");
  const { data, error } = await client
    .from("events")
    .insert({
      name: row.name,
      type: row.type,
      start_date: row.start_date,
      end_date: row.end_date,
      note: row.note || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * @param {string} id
 */
export async function deleteEventById(id) {
  if (!client) throw new Error("Supabase nicht initialisiert");
  const { error } = await client.from("events").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Echtzeit: INSERT + DELETE
 * @param {{ onInsert?: () => void, onDelete?: () => void, onStatus?: (status: string) => void }} handlers
 * @returns {() => void} unsubscribe
 */
export function subscribeToEvents(handlers) {
  if (!client) throw new Error("Supabase nicht initialisiert");
  if (eventsChannel) {
    try {
      client.removeChannel(eventsChannel);
    } catch {
      void 0;
    }
  }
  eventsChannel = client
    .channel("team-kalender-events")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "events" },
      (payload) => {
        if (payload.new && handlers.onInsert) handlers.onInsert(payload.new);
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "events" },
      (payload) => {
        if (payload.old && handlers.onDelete) handlers.onDelete({ id: payload.old.id });
      }
    )
    .subscribe((status) => {
      if (handlers.onStatus) handlers.onStatus(status);
    });

  return () => {
    if (client && eventsChannel) {
      try {
        client.removeChannel(eventsChannel);
      } catch {
        void 0;
      }
    }
    eventsChannel = null;
  };
}
