import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

const DEFAULT_CORS: string[] = [
  "https://pgoutzeris-stack.github.io",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
];

function extraOriginsFromEnv(): string[] {
  const raw = Deno.env.get("TEAM_KALENDER_CORS_ORIGINS");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function buildAllowedSet(): Set<string> {
  return new Set([...DEFAULT_CORS, ...extraOriginsFromEnv()]);
}

function defaultFallbackOrigin() {
  return "https://pgoutzeris-stack.github.io";
}

function corsHeaders(req: Request) {
  const allowed = buildAllowedSet();
  const o = req.headers.get("origin");
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
  if (o && allowed.has(o)) {
    h["Access-Control-Allow-Origin"] = o;
  } else if (!o) {
    h["Access-Control-Allow-Origin"] = defaultFallbackOrigin();
  }
  return h;
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  // db.schema zeigt auf das team_kalender Schema
  return createClient(url, key, {
    db: { schema: "team_kalender" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function publicServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function syncRootsClosures(userId: string) {
  const pub = publicServiceClient();
  const { error } = await pub.rpc("sync_roots_closures_for_user", {
    p_user_id: userId,
    p_year: new Date().getFullYear(),
  });
  if (error) console.error("[team-kalender] sync_roots_closures", error.message);
}

type EventRow = {
  id: string;
  member_id: string;
  type: string;
  title: string | null;
  start_date: string;
  end_date: string;
  day_part: string | null;
  note: string | null;
  created_at: string;
  is_system: boolean;
  team_members: { name: string; kuerzel: string | null } | null;
};

function deriveKuerzel(name: string, stored?: string | null): string {
  const k = (stored || "").trim().toUpperCase();
  if (k.length >= 2) return k.slice(0, 4);
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (parts[0]?.slice(0, 2) || "??").toUpperCase();
}

async function profileKuerzel(userId: string, name: string): Promise<string> {
  const pub = publicServiceClient();
  const { data } = await pub
    .schema("users")
    .from("profiles")
    .select("kuerzel,full_name,email")
    .eq("id", userId)
    .maybeSingle();
  return deriveKuerzel(
    (data?.full_name as string) || (data?.email as string) || name,
    data?.kuerzel as string | null,
  );
}

const SYSTEM_BLOCK_MSG =
  "Betriebsferien und verpflichtende ROOTS-Tage können nur in den Einstellungen der Urlaubsplanung bearbeitet werden.";

const URLAUB_MANUAL_BLOCK_MSG =
  "Urlaub kann nicht direkt im Team-Kalender eingetragen werden. Bitte über die Urlaubsplanung beantragen – genehmigte Urlaube werden automatisch eingetragen.";

function urlaubBlockedResponse(c: Record<string, string>) {
  return new Response(JSON.stringify({ error: URLAUB_MANUAL_BLOCK_MSG }), {
    status: 403,
    headers: { ...c, "Content-Type": "application/json" },
  });
}

function approvedUrlaubBlockedResponse(c: Record<string, string>) {
  return new Response(
    JSON.stringify({
      error:
        "Genehmigter Urlaub kann nur über die Urlaubsplanung geändert oder gelöscht werden.",
    }),
    { status: 403, headers: { ...c, "Content-Type": "application/json" } },
  );
}

async function getAuthUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return null;
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  const client = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;
  return user;
}

async function isRequestAdmin(req: Request): Promise<boolean> {
  const user = await getAuthUser(req);
  if (!user) return false;
  const pub = publicServiceClient();
  const { data } = await pub
    .schema("users")
    .from("profiles")
    .select("app_role")
    .eq("id", user.id)
    .maybeSingle();
  return data?.app_role === "admin";
}

async function loadApprovedUrlaubEventIds(): Promise<Set<string>> {
  const pub = publicServiceClient();
  const { data, error } = await pub
    .from("urlaub_requests")
    .select("calendar_event_id")
    .eq("status", "approved")
    .not("calendar_event_id", "is", null);
  if (error) throw error;
  return new Set(
    (data ?? [])
      .map((r) => String(r.calendar_event_id || ""))
      .filter(Boolean),
  );
}

async function isApprovedUrlaubEvent(eventId: string): Promise<boolean> {
  const pub = publicServiceClient();
  const { data, error } = await pub
    .from("urlaub_requests")
    .select("id")
    .eq("calendar_event_id", eventId)
    .eq("status", "approved")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function systemBlockedResponse(c: Record<string, string>) {
  return new Response(JSON.stringify({ error: SYSTEM_BLOCK_MSG }), {
    status: 403,
    headers: { ...c, "Content-Type": "application/json" },
  });
}

function eventOut(e: EventRow, approvedUrlaubIds?: Set<string>) {
  const dayPart = e.day_part === "am" || e.day_part === "pm" ? e.day_part : "full";
  return {
    id: e.id,
    member_id: e.member_id,
    type: e.type,
    title: e.title,
    start_date: e.start_date,
    end_date: e.end_date,
    day_part: dayPart,
    note: e.note,
    created_at: e.created_at,
    is_system: Boolean(e.is_system),
    is_approved_urlaub: Boolean(approvedUrlaubIds?.has(e.id)),
    member_name: e.team_members?.name ?? null,
    member_kuerzel: e.team_members?.kuerzel ?? null,
  };
}

function normalizeDayPart(value: unknown): "full" | "am" | "pm" {
  const v = String(value ?? "full").trim().toLowerCase();
  if (v === "am" || v === "pm") return v;
  return "full";
}

Deno.serve(async (req) => {
  const c = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: c });
  }

  let supa;
  try {
    supa = serviceClient();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "config" }),
      { status: 500, headers: { ...c, "Content-Type": "application/json" } },
    );
  }

  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      if (url.searchParams.get("list") === "nrw_holidays") {
        const { data, error } = await supa
          .from("nrw_holidays")
          .select("holiday_date,label")
          .order("holiday_date", { ascending: true });
        if (error) throw error;
        return new Response(JSON.stringify(data ?? []), {
          status: 200,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      if (url.searchParams.get("list") === "members") {
        const { data, error } = await supa
          .from("team_members")
          .select("id,name,user_id,created_at")
          .order("name", { ascending: true });
        if (error) throw error;
        return new Response(JSON.stringify(data ?? []), {
          status: 200,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supa
        .from("events")
        .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,team_members(name,kuerzel)")
        .order("start_date", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as EventRow[];
      const approvedUrlaubIds = await loadApprovedUrlaubEventIds();
      const flat = rows.map((e) => eventOut(e, approvedUrlaubIds));
      return new Response(JSON.stringify(flat), {
        status: 200,
        headers: { ...c, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const kind = String(body.kind ?? "event").toLowerCase();

      if (kind === "ensure_member") {
        const user_id = String(body.user_id ?? "").trim();
        const name = String(body.name ?? "").trim();
        if (!user_id || name.length < 1) {
          return new Response(
            JSON.stringify({ error: "user_id und name erforderlich" }),
            { status: 400, headers: { ...c, "Content-Type": "application/json" } },
          );
        }
        await syncRootsClosures(user_id);
        const kuerzel = await profileKuerzel(user_id, name);
        const { data: byUser } = await supa
          .from("team_members")
          .select("id,name,user_id,kuerzel,created_at")
          .eq("user_id", user_id)
          .maybeSingle();
        if (byUser) {
          if (byUser.name !== name || byUser.kuerzel !== kuerzel) {
            const { data: updated, error: uErr } = await supa
              .from("team_members")
              .update({ name, kuerzel })
              .eq("id", byUser.id)
              .select("id,name,user_id,kuerzel,created_at")
              .single();
            if (uErr) throw uErr;
            return new Response(JSON.stringify(updated), {
              status: 200,
              headers: { ...c, "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(byUser), {
            status: 200,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        // Nur unverknüpfte Legacy-Zeilen (user_id NULL) übernehmen — nie fremde Konten umbiegen
        const { data: orphan } = await supa
          .from("team_members")
          .select("id,name,user_id,created_at")
          .eq("name", name)
          .is("user_id", null)
          .maybeSingle();
        if (orphan) {
          const { data: linked, error: lErr } = await supa
            .from("team_members")
            .update({ user_id, name, kuerzel })
            .eq("id", orphan.id)
            .is("user_id", null)
            .select("id,name,user_id,kuerzel,created_at")
            .single();
          if (lErr) throw lErr;
          return new Response(JSON.stringify(linked), {
            status: 200,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        let insertName = name;
        let { data, error } = await supa
          .from("team_members")
          .insert({ name: insertName, user_id, kuerzel })
          .select("id,name,user_id,kuerzel,created_at")
          .single();
        if (error?.code === "23505") {
          insertName = `${name} (${user_id.slice(0, 8)})`;
          ({ data, error } = await supa
            .from("team_members")
            .insert({ name: insertName, user_id, kuerzel })
            .select("id,name,user_id,kuerzel,created_at")
            .single());
        }
        if (error) throw error;
        return new Response(JSON.stringify(data), {
          status: 201,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      if (kind === "event_update") {
        const id = String(body.id ?? "").trim();
        const type = String(body.type ?? "");
        const start_date = String(body.start_date ?? "");
        const end_date = String(body.end_date ?? "");
        const day_part = normalizeDayPart(body.day_part);
        const title = String(body.title ?? "").trim();
        const note =
          body.note == null || body.note === "" ? null : String(body.note);
        if (!id || !start_date || !end_date) {
          return new Response(
            JSON.stringify({ error: "id, start_date, end_date erforderlich" }),
            { status: 400, headers: { ...c, "Content-Type": "application/json" } },
          );
        }
        if (day_part !== "full" && start_date !== end_date) {
          return new Response(
            JSON.stringify({ error: "Halbtage sind nur für einzelne Kalendertage möglich" }),
            { status: 400, headers: { ...c, "Content-Type": "application/json" } },
          );
        }
        const { data: existing, error: loadErr } = await supa
          .from("events")
          .select("id,type,is_system")
          .eq("id", id)
          .maybeSingle();
        if (loadErr) throw loadErr;
        if (!existing) {
          return new Response(JSON.stringify({ error: "Eintrag nicht gefunden" }), {
            status: 404,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        if (existing.is_system) {
          return systemBlockedResponse(c);
        }
        if (existing.type === "urlaub" || type === "urlaub") {
          const admin = await isRequestAdmin(req);
          if (!admin) return urlaubBlockedResponse(c);
          if (await isApprovedUrlaubEvent(id)) return approvedUrlaubBlockedResponse(c);
        }
        if (title.length < 1) {
          return new Response(JSON.stringify({ error: "title erforderlich" }), {
            status: 400,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        const allowed = ["urlaub", "krank", "dienstreise", "sonstiges"];
        if (!allowed.includes(type)) {
          return new Response(JSON.stringify({ error: "Ungültiger Ereignistyp" }), {
            status: 400,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        const { data, error } = await supa
          .from("events")
          .update({ type, title, start_date, end_date, day_part, note })
          .eq("id", id)
          .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,team_members(name,kuerzel)")
          .single();
        if (error) throw error;
        const e = data as EventRow;
        const approvedUrlaubIds = await loadApprovedUrlaubEventIds();
        return new Response(JSON.stringify(eventOut(e, approvedUrlaubIds)), {
          status: 200,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      if (kind === "member") {
        const name = String(body.name ?? "").trim();
        if (name.length < 1) {
          return new Response(
            JSON.stringify({ error: "name erforderlich" }),
            { status: 400, headers: { ...c, "Content-Type": "application/json" } },
          );
        }
        const { data, error } = await supa
          .from("team_members")
          .insert({ name })
          .select("id,name,created_at")
          .single();
        if (error) {
          const isDup =
            (error as { code?: string }).code === "23505" ||
            /duplicate|unique/i.test(error.message);
          if (isDup) {
            return new Response(
              JSON.stringify({ error: "Dieser Name existiert bereits" }),
              { status: 409, headers: { ...c, "Content-Type": "application/json" } },
            );
          }
          throw error;
        }
        return new Response(JSON.stringify(data), {
          status: 201,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      const member_id = String(body.member_id ?? "").trim();
      const type = String(body.type ?? "");
      const title = String(body.title ?? "").trim();
      const start_date = String(body.start_date ?? "");
      const end_date = String(body.end_date ?? "");
      const day_part = normalizeDayPart(body.day_part);
      const note =
        body.note == null || body.note === "" ? null : String(body.note);
      if (!member_id || !start_date || !end_date) {
        return new Response(
          JSON.stringify({ error: "member_id, start_date, end_date erforderlich" }),
          { status: 400, headers: { ...c, "Content-Type": "application/json" } },
        );
      }
      if (day_part !== "full" && start_date !== end_date) {
        return new Response(
          JSON.stringify({ error: "Halbtage sind nur für einzelne Kalendertage möglich" }),
          { status: 400, headers: { ...c, "Content-Type": "application/json" } },
        );
      }
      if (title.length < 1) {
        return new Response(JSON.stringify({ error: "title erforderlich" }), {
          status: 400,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
      const allowed = ["urlaub", "krank", "dienstreise", "sonstiges"];
      if (!allowed.includes(type)) {
        return new Response(JSON.stringify({ error: "Ungültiger Ereignistyp" }), {
          status: 400,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
      if (type === "urlaub") {
        const admin = await isRequestAdmin(req);
        if (!admin) return urlaubBlockedResponse(c);
      }
      const { data, error } = await supa
        .from("events")
        .insert({ member_id, type, title, start_date, end_date, day_part, note })
        .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,team_members(name,kuerzel)")
        .single();
      if (error) throw error;
      const e = data as EventRow;
      const approvedUrlaubIds = await loadApprovedUrlaubEventIds();
      return new Response(JSON.stringify(eventOut(e, approvedUrlaubIds)), {
        status: 201,
        headers: { ...c, "Content-Type": "application/json" },
      });
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) {
        return new Response(JSON.stringify({ error: "id fehlt" }), {
          status: 400,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
      const target = (url.searchParams.get("target") ?? "event").toLowerCase();
      if (target === "member") {
        const { count, error: cErr } = await supa
          .from("events")
          .select("id", { count: "exact", head: true })
          .eq("member_id", id);
        if (cErr) throw cErr;
        if (count && count > 0) {
          return new Response(
            JSON.stringify({
              error: "Kann Teammitglied nicht löschen: Es gibt noch Kalendereinträge",
            }),
            { status: 409, headers: { ...c, "Content-Type": "application/json" } },
          );
        }
        const { error } = await supa.from("team_members").delete().eq("id", id);
        if (error) throw error;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
      const { data: evRow, error: evLoadErr } = await supa
        .from("events")
        .select("type,is_system")
        .eq("id", id)
        .maybeSingle();
      if (evLoadErr) throw evLoadErr;
      if (evRow?.is_system) {
        return systemBlockedResponse(c);
      }
      if (evRow?.type === "urlaub") {
        const admin = await isRequestAdmin(req);
        if (!admin) return urlaubBlockedResponse(c);
        if (await isApprovedUrlaubEvent(id)) return approvedUrlaubBlockedResponse(c);
      }
      const { error } = await supa.from("events").delete().eq("id", id);
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...c, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...c, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Serverfehler";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...c, "Content-Type": "application/json" },
    });
  }
});
