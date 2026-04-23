import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.0";

/**
 * Feste erlaubte Origins (GitHub Pages = nur Host, ohne Pfad – der Browser sendet
 * z. B. https://user.github.io auch für /Repo/unterseiten).
 *
 * Weitere Origins: Supabase → Project → Edge Functions → Secrets
 *   TEAM_KALENDER_CORS_ORIGINS = https://andere-domain.de,https://preview.example.com
 * Kein Slash am Ende, kein Pfad. Danach: supabase functions deploy team-kalender
 */
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
      const { data, error } = await supa
        .from("events")
        .select("id,name,type,start_date,end_date,note,created_at")
        .order("start_date", { ascending: true });
      if (error) throw error;
      return new Response(JSON.stringify(data ?? []), {
        status: 200,
        headers: { ...c, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const name = String(body.name ?? "").trim();
      const type = String(body.type ?? "");
      const start_date = String(body.start_date ?? "");
      const end_date = String(body.end_date ?? "");
      const note = body.note == null || body.note === "" ? null : String(body.note);
      if (!name || !start_date || !end_date) {
        return new Response(
          JSON.stringify({ error: "name, start_date, end_date erforderlich" }),
          { status: 400, headers: { ...c, "Content-Type": "application/json" } },
        );
      }
      const allowed = ["urlaub", "krank", "homeoffice", "dienstreise", "sonstiges"];
      if (!allowed.includes(type)) {
        return new Response(JSON.stringify({ error: "Ungültiger Ereignistyp" }), {
          status: 400,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supa
        .from("events")
        .insert({ name, type, start_date, end_date, note })
        .select()
        .single();
      if (error) throw error;
      return new Response(JSON.stringify(data), {
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
