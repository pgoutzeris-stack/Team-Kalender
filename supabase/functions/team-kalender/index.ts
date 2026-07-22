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

/** ──────────────────────────────────────────────────────────────────────
 *  Urlaubstage-Berechnung
 *  Zählt Arbeitstage (Mo–Fr) zwischen zwei Daten inkl. beider Grenzen,
 *  abzüglich NRW-Feiertage in der Tabelle team_kalender.nrw_holidays.
 *  day_part 'am'/'pm' = 0,5 Tage statt 1.
 * ─────────────────────────────────────────────────────────────────────── */
async function countVacationDays(
  startDate: string,
  endDate: string,
  dayPart: string,
  supa: ReturnType<typeof serviceClient>,
): Promise<number> {
  const start = new Date(startDate + "T00:00:00Z");
  const end   = new Date(endDate   + "T00:00:00Z");
  if (end < start) return 0;

  // NRW-Feiertage im Zeitraum holen
  const { data: holidays } = await supa
    .from("nrw_holidays")
    .select("holiday_date")
    .gte("holiday_date", startDate)
    .lte("holiday_date", endDate);
  const holidaySet = new Set((holidays ?? []).map((h: { holiday_date: string }) => h.holiday_date));

  let days = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0=So, 6=Sa
    const ymd = cur.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(ymd)) days++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  // Halber Tag (Vormittag / Nachmittag) bei eintägigen Einträgen
  if ((dayPart === "am" || dayPart === "pm") && startDate === endDate && days === 1) {
    return 0.5;
  }
  return days;
}

/** Findet die user_id zu einer member_id */
async function userIdForMember(
  memberId: string,
  supa: ReturnType<typeof serviceClient>,
): Promise<string | null> {
  const { data } = await supa
    .from("team_members")
    .select("user_id")
    .eq("id", memberId)
    .maybeSingle();
  return data?.user_id ?? null;
}

/** Zieht Urlaubstage vom Profil ab (negativ = gutschreiben) */
async function adjustUrlaubstage(
  userId: string,
  delta: number, // positiv = abziehen, negativ = gutschreiben
): Promise<void> {
  if (!userId || delta === 0) return;
  const pub = publicServiceClient();
  const { error } = await pub.rpc("adjust_urlaubstage_by_delta", { p_user_id: userId, p_delta: delta });
  if (error) throw error;
}

async function loadRemainingUrlaubstage(userId: string): Promise<number> {
  const pub = publicServiceClient();
  const { data, error } = await pub
    .schema("users")
    .from("profiles")
    .select("urlaubstage")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  const remaining = Number(data?.urlaubstage ?? 0);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

async function ensureUrlaubstageAvailable(
  userId: string | null,
  requestedDelta: number,
): Promise<void> {
  if (!userId || requestedDelta <= 0) return;
  const remaining = await loadRemainingUrlaubstage(userId);
  if (requestedDelta > remaining) {
    throw new Error(
      `Nicht genug Urlaubstage (${remaining} verfügbar, ${requestedDelta} benötigt)`,
    );
  }
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
  urlaub_request_id: string | null;
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
    .select("id,calendar_event_id")
    .eq("status", "approved");
  if (error) throw error;
  const ids = new Set(
    (data ?? [])
      .map((r) => String(r.calendar_event_id || ""))
      .filter(Boolean),
  );
  const requestIds = (data ?? []).map((r) => String(r.id || "")).filter(Boolean);
  if (requestIds.length) {
    const kal = serviceClient();
    const { data: linkedEvents, error: linkedErr } = await kal
      .from("events")
      .select("id")
      .in("urlaub_request_id", requestIds);
    if (linkedErr) throw linkedErr;
    for (const ev of linkedEvents ?? []) {
      if (ev.id) ids.add(String(ev.id));
    }
  }
  return ids;
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
  if (data) return true;

  const kal = serviceClient();
  const { data: ev, error: evErr } = await kal
    .from("events")
    .select("urlaub_request_id")
    .eq("id", eventId)
    .not("urlaub_request_id", "is", null)
    .maybeSingle();
  if (evErr) throw evErr;
  if (!ev?.urlaub_request_id) return false;

  const { data: reqRow, error: reqErr } = await pub
    .from("urlaub_requests")
    .select("id")
    .eq("id", ev.urlaub_request_id)
    .eq("status", "approved")
    .maybeSingle();
  if (reqErr) throw reqErr;
  return Boolean(reqRow);
}

function systemBlockedResponse(c: Record<string, string>) {
  return new Response(JSON.stringify({ error: SYSTEM_BLOCK_MSG }), {
    status: 403,
    headers: { ...c, "Content-Type": "application/json" },
  });
}

function eventOut(e: EventRow, approvedUrlaubIds?: Set<string>) {
  return {
    id: e.id,
    member_id: e.member_id,
    type: e.type,
    title: e.title,
    start_date: e.start_date,
    end_date: e.end_date,
    day_part: e.day_part ?? "full",
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

function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T12:00:00`);
}

function addDaysYmd(ymd: string, n: number): string {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekendYmd(ymd: string): boolean {
  const wd = parseYmd(ymd).getDay();
  return wd === 0 || wd === 6;
}

function* eachDayYmd(start: string, end: string): Generator<string> {
  let cur = start;
  while (cur <= end) {
    yield cur;
    cur = addDaysYmd(cur, 1);
  }
}

async function loadHolidayMap(
  kal: ReturnType<typeof createClient>,
  start: string,
  end: string,
): Promise<Map<string, string>> {
  const { data, error } = await kal
    .from("nrw_holidays")
    .select("holiday_date,label")
    .gte("holiday_date", start)
    .lte("holiday_date", end);
  if (error) throw error;
  const map = new Map<string, string>();
  for (const h of data ?? []) {
    map.set(String(h.holiday_date).slice(0, 10), String(h.label));
  }
  return map;
}

function splitWorkingDaySegments(
  start: string,
  end: string,
  holidays: Map<string, string>,
): Array<{ start_date: string; end_date: string }> {
  const segments: Array<{ start_date: string; end_date: string }> = [];
  let currentStart: string | null = null;
  let previousWorking: string | null = null;

  for (const day of eachDayYmd(start, end)) {
    const isWorking = !isWeekendYmd(day) && !holidays.has(day);
    if (!isWorking) {
      if (currentStart && previousWorking) {
        segments.push({ start_date: currentStart, end_date: previousWorking });
      }
      currentStart = null;
      previousWorking = null;
      continue;
    }
    if (!currentStart) currentStart = day;
    previousWorking = day;
  }

  if (currentStart && previousWorking) {
    segments.push({ start_date: currentStart, end_date: previousWorking });
  }
  return segments;
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
    const requestUser = await getAuthUser(req);
    if (!requestUser) {
      return new Response(JSON.stringify({ error: "Nicht angemeldet" }), {
        status: 401,
        headers: { ...c, "Content-Type": "application/json" },
      });
    }
    const requestIsAdmin = await isRequestAdmin(req);

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

      if (url.searchParams.get("list") === "quota") {
        if (!requestIsAdmin) {
          return new Response(JSON.stringify({ error: "Adminrechte erforderlich" }), {
            status: 403,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        const year = Number(url.searchParams.get("year") || new Date().getFullYear());
        const pub = publicServiceClient();
        const { data: profiles, error: profileErr } = await pub
          .schema("users")
          .from("profiles")
          .select("id,full_name,email,urlaubstage,urlaubstage_jahr")
          .order("full_name", { ascending: true });
        if (profileErr) throw profileErr;

        const { data: closureDays, error: closureErr } = await supa
          .from("roots_closure_days")
          .select("id")
          .eq("calendar_year", year);
        if (closureErr) throw closureErr;

        const closureByUser: Record<string, number> = {};
        const closureIds = (closureDays ?? []).map((d) => d.id).filter(Boolean);
        if (closureIds.length) {
          const { data: assignments, error: assignmentErr } = await pub
            .from("roots_closure_assignments")
            .select("user_id,deducted_days")
            .in("closure_day_id", closureIds);
          if (assignmentErr) throw assignmentErr;
          for (const row of assignments ?? []) {
            const userId = String(row.user_id || "");
            if (!userId) continue;
            closureByUser[userId] = (closureByUser[userId] ?? 0) + Number(row.deducted_days || 0);
          }
        }

        const quota = (profiles ?? []).filter((p) => {
          const email = String(p.email || "").toLowerCase();
          return email && !email.endsWith("@test.de");
        }).map((p) => {
          const initial = Number(p.urlaubstage_jahr ?? 30);
          const remaining = Number(p.urlaubstage ?? initial);
          const betrieb = closureByUser[p.id] ?? 0;
          const used = initial - remaining - betrieb;
          return {
            user_id: p.id,
            full_name: p.full_name,
            initial,
            betrieb,
            used: Math.max(0, used),
            remaining,
          };
        });
        return new Response(JSON.stringify(quota), {
          status: 200,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supa
        .from("events")
        .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,urlaub_request_id,team_members(name,kuerzel)")
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
        if (user_id !== requestUser.id && !requestIsAdmin) {
          return new Response(JSON.stringify({ error: "Fremdes Profil nicht erlaubt" }), {
            status: 403,
            headers: { ...c, "Content-Type": "application/json" },
          });
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
        const title = String(body.title ?? "").trim();
        const note =
          body.note == null || body.note === "" ? null : String(body.note);
        if (!id || !start_date || !end_date) {
          return new Response(
            JSON.stringify({ error: "id, start_date, end_date erforderlich" }),
            { status: 400, headers: { ...c, "Content-Type": "application/json" } },
          );
        }
        const { data: existing, error: loadErr } = await supa
          .from("events")
          .select("id,type,start_date,end_date,day_part,member_id,is_system")
          .eq("id", id)
          .maybeSingle();
        if (loadErr) throw loadErr;
        if (!existing) {
          return new Response(JSON.stringify({ error: "Eintrag nicht gefunden" }), {
            status: 404,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        const existingUserId = existing.member_id
          ? await userIdForMember(existing.member_id, supa)
          : null;
        if (existingUserId !== requestUser.id && !requestIsAdmin) {
          return new Response(JSON.stringify({ error: "Nur eigene Einträge können bearbeitet werden" }), {
            status: 403,
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
        const day_part_upd = String(body.day_part ?? existing?.day_part ?? "full");
        if (type === "urlaub") {
          const holidays = await loadHolidayMap(supa, start_date, end_date);
          const segments = splitWorkingDaySegments(start_date, end_date, holidays);
          const approvedUrlaubIds = await loadApprovedUrlaubEventIds();
          const userId = existing?.member_id ? await userIdForMember(existing.member_id, supa) : null;
          const oldDays = existing.type === "urlaub"
            ? await countVacationDays(existing.start_date, existing.end_date, existing.day_part ?? "full", supa)
            : 0;
          const newDays = await countVacationDays(start_date, end_date, day_part_upd, supa);
          await ensureUrlaubstageAvailable(userId, newDays - oldDays);
          if (!segments.length) {
            const { error: delErr } = await supa.from("events").delete().eq("id", id);
            if (delErr) throw delErr;
            if (userId && oldDays) await adjustUrlaubstage(userId, -oldDays);
            return new Response(JSON.stringify({ events: [] }), {
              status: 200,
              headers: { ...c, "Content-Type": "application/json" },
            });
          }

          const first = segments[0];
          const firstDayPart =
            segments.length === 1 && first.start_date === first.end_date ? day_part_upd : "full";
          const { data: updated, error: updateErr } = await supa
            .from("events")
            .update({
              type,
              title,
              start_date: first.start_date,
              end_date: first.end_date,
              day_part: firstDayPart,
              note,
            })
            .eq("id", id)
            .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,urlaub_request_id,team_members(name,kuerzel)")
            .single();
          if (updateErr) throw updateErr;

          const rows = [updated as EventRow];
          if (segments.length > 1) {
            const restPayload = segments.slice(1).map((segment) => ({
              member_id: existing.member_id,
              type,
              title,
              start_date: segment.start_date,
              end_date: segment.end_date,
              day_part: "full",
              note,
            }));
            const { data: inserted, error: insertErr } = await supa
              .from("events")
              .insert(restPayload)
              .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,urlaub_request_id,team_members(name,kuerzel)");
            if (insertErr) throw insertErr;
            rows.push(...((inserted ?? []) as EventRow[]));
          }

          if (userId) {
            const delta = newDays - oldDays;
            await adjustUrlaubstage(userId, delta);
          }
          const out = rows.map((e) => eventOut(e, approvedUrlaubIds));
          return new Response(
            JSON.stringify(out.length === 1 ? out[0] : { events: out }),
            { status: 200, headers: { ...c, "Content-Type": "application/json" } },
          );
        }
        const { data, error } = await supa
          .from("events")
          .update({ type, title, start_date, end_date, note, day_part: day_part_upd })
          .eq("id", id)
          .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,urlaub_request_id,team_members(name,kuerzel)")
          .single();
        if (error) throw error;

        // Urlaubstage-Differenz anpassen
        if ((existing?.type === "urlaub" || type === "urlaub") && existing?.member_id) {
          const userId = await userIdForMember(existing.member_id, supa);
          if (userId) {
            const oldDays = existing.type === "urlaub"
              ? await countVacationDays(existing.start_date, existing.end_date, existing.day_part ?? "full", supa)
              : 0;
            const newDays = type === "urlaub"
              ? await countVacationDays(start_date, end_date, day_part_upd, supa)
              : 0;
            const delta = newDays - oldDays; // positiv = mehr Urlaub → abziehen, negativ → gutschreiben
            await ensureUrlaubstageAvailable(userId, delta);
            await adjustUrlaubstage(userId, delta);
          }
        }

        const e = data as EventRow;
        const approvedUrlaubIds = await loadApprovedUrlaubEventIds();
        return new Response(JSON.stringify(eventOut(e, approvedUrlaubIds)), {
          status: 200,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }

      if (kind === "member") {
        if (!requestIsAdmin) {
          return new Response(JSON.stringify({ error: "Adminrechte erforderlich" }), {
            status: 403,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
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
      const note =
        body.note == null || body.note === "" ? null : String(body.note);
      if (!member_id || !start_date || !end_date) {
        return new Response(
          JSON.stringify({ error: "member_id, start_date, end_date erforderlich" }),
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
      const day_part = String(body.day_part ?? "full");
      const targetUserId = await userIdForMember(member_id, supa);
      if (targetUserId !== requestUser.id && !requestIsAdmin) {
        return new Response(JSON.stringify({ error: "Nur eigene Einträge können erstellt werden" }), {
          status: 403,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
      if (type === "urlaub") {
        const admin = await isRequestAdmin(req);
        if (!admin) return urlaubBlockedResponse(c);
        const holidays = await loadHolidayMap(supa, start_date, end_date);
        const segments = splitWorkingDaySegments(start_date, end_date, holidays);
        if (!segments.length) {
          return new Response(JSON.stringify({ events: [] }), {
            status: 201,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
        const userId = await userIdForMember(member_id, supa);
        const days = await countVacationDays(start_date, end_date, day_part, supa);
        await ensureUrlaubstageAvailable(userId, days);
        const rowsToInsert = segments.map((segment) => ({
          member_id,
          type,
          title,
          start_date: segment.start_date,
          end_date: segment.end_date,
          day_part:
            segments.length === 1 && segment.start_date === segment.end_date ? day_part : "full",
          note,
        }));
        const { data, error } = await supa
          .from("events")
          .insert(rowsToInsert)
          .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,urlaub_request_id,team_members(name,kuerzel)");
        if (error) throw error;
        const approvedUrlaubIds = await loadApprovedUrlaubEventIds();
        const out = ((data ?? []) as EventRow[]).map((e) => eventOut(e, approvedUrlaubIds));
        if (userId) await adjustUrlaubstage(userId, days);
        return new Response(
          JSON.stringify(out.length === 1 ? out[0] : { events: out }),
          { status: 201, headers: { ...c, "Content-Type": "application/json" } },
        );
      }
      const { data, error } = await supa
        .from("events")
        .insert({ member_id, type, title, start_date, end_date, day_part, note })
        .select("id,member_id,type,title,start_date,end_date,day_part,note,created_at,is_system,urlaub_request_id,team_members(name,kuerzel)")
        .single();
      if (error) throw error;

      // Urlaubstage abziehen wenn Admin direkt Urlaub einträgt
      if (type === "urlaub") {
        const userId = await userIdForMember(member_id, supa);
        if (userId) {
          const days = await countVacationDays(start_date, end_date, day_part, supa);
          await adjustUrlaubstage(userId, days);
        }
      }

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
        if (!requestIsAdmin) {
          return new Response(JSON.stringify({ error: "Adminrechte erforderlich" }), {
            status: 403,
            headers: { ...c, "Content-Type": "application/json" },
          });
        }
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
        .select("type,start_date,end_date,day_part,member_id,is_system")
        .eq("id", id)
        .maybeSingle();
      if (evLoadErr) throw evLoadErr;
      const eventUserId = evRow?.member_id ? await userIdForMember(evRow.member_id, supa) : null;
      if (eventUserId !== requestUser.id && !requestIsAdmin) {
        return new Response(JSON.stringify({ error: "Nur eigene Einträge können gelöscht werden" }), {
          status: 403,
          headers: { ...c, "Content-Type": "application/json" },
        });
      }
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

      // Urlaubstage zurückgeben wenn Admin-Urlaub gelöscht
      if (evRow?.type === "urlaub" && evRow?.member_id) {
        const userId = await userIdForMember(evRow.member_id, supa);
        if (userId) {
          const days = await countVacationDays(evRow.start_date, evRow.end_date, evRow.day_part ?? "full", supa);
          await adjustUrlaubstage(userId, -days); // negativ = gutschreiben
        }
      }

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
