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
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type EventRow = {
  id: string;
  member_id: string;
  type: string;
  start_date: string;
  end_date: string;
  note: string | null;
  created_at: string;
  team_members: { name: string } | null;
};

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
      if (url.searchParams.get("list") === "members") {
        const { data, error } = await supa
          .from("team_members")
          .select("id,name,created_at")
          .order("name", { ascending: true });
        if (error) throw error;
        return new Response(JSON.stringify(data ?? []), {
          status: 200,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supa
        .from("events")
        .select("id,member_id,type,start_date,end_date,note,created_at,team_members(name)")
        .order("start_date", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as EventRow[];
      const flat = rows.map((e) => ({
        id: e.id,
        member_id: e.member_id,
        type: e.type,
        start_date: e.start_date,
        end_date: e.end_date,
        note: e.note,
        created_at: e.created_at,
        member_name: e.team_members?.name ?? null,
      }));
      return new Response(JSON.stringify(flat), {
        status: 200,
        headers: { ...c, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const kind = String(body.kind ?? "event").toLowerCase();

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
      const start_date = String(body.start_date ?? "");
      const end_date = String(body.end_date ?? "");
      const note =
        body.note == null || body.note === "" ? null : String(body.note);
      if (!member_id || !start_date || !end_date) {
        return new Response(
          JSON.stringify({ error: "member_id, start_date, end_date erforderlich" }),
          { status: 400, headers: { ...c, "Content-Type": "application/json" } },
        );
      }
      const allowed = [
        "urlaub",
        "krank",
        "homeoffice",
        "dienstreise",
        "sonstiges",
      ];
      if (!allowed.includes(type)) {
        return new Response(JSON.stringify({ error: "Ungültiger Ereignistyp" }), {
          status: 400,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supa
        .from("events")
        .insert({ member_id, type, start_date, end_date, note })
        .select("id,member_id,type,start_date,end_date,note,created_at,team_members(name)")
        .single();
      if (error) throw error;
      const e = data as EventRow;
      const out = {
        id: e.id,
        member_id: e.member_id,
        type: e.type,
        start_date: e.start_date,
        end_date: e.end_date,
        note: e.note,
        created_at: e.created_at,
        member_name: e.team_members?.name ?? null,
      };
      return new Response(JSON.stringify(out), {
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
