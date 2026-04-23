/**
 * ROOTS Team-Abwesenheitskalender – UI, FullCalendar, Modals, Toasts
 */
import { Calendar } from "https://esm.sh/@fullcalendar/core@6.1.10";
import dayGridPlugin from "https://esm.sh/@fullcalendar/daygrid@6.1.10";
import timeGridPlugin from "https://esm.sh/@fullcalendar/timegrid@6.1.10";
import interactionPlugin from "https://esm.sh/@fullcalendar/interaction@6.1.10";
import multiMonthPlugin from "https://esm.sh/@fullcalendar/multimonth@6.1.10";
import { TEAM_KALENDER_API_URL } from "./config.js";
import {
  fetchAllEvents,
  insertEvent,
  deleteEventById,
  startEventPolling,
} from "./supabase-events.js";
import { getNrwFeiertageAsCalendarEvents } from "./nrw-feiertage.js";

const TYPE_LABELS = {
  urlaub: "Urlaub",
  krank: "Krank / krankheitsbedingt",
  homeoffice: "Homeoffice",
  dienstreise: "Dienstreise",
  sonstiges: "Sonstiges",
};

const TYPE_COLORS = {
  urlaub: { bg: "#206efb", fg: "#ffffff" },
  krank: { bg: "#dc2626", fg: "#ffffff" },
  homeoffice: { bg: "#10b981", fg: "#ffffff" },
  dienstreise: { bg: "#f59e0b", fg: "#0f172a" },
  sonstiges: { bg: "#475569", fg: "#ffffff" },
  nrw: { bg: "#e2e8f0", fg: "#0f172a" },
};

let calendar = null;
let dbRows = [];
let searchQuery = "";
let nrwSourceId = "nrw-feiertage";
const els = {
  cal: null,
  toast: null,
  modalOvl: null,
  modalOvl2: null,
  formName: null,
  formType: null,
  formStart: null,
  formEnd: null,
  formNote: null,
  dName: null,
  dType: null,
  dRange: null,
  dNote: null,
  search: null,
  badge: null,
  btnCreate: null,
  btnViewMonth: null,
  btnViewWeek: null,
  btnViewYear: null,
  detailDelete: null,
};

let detailEventId = null;
let isNrwEvent = false;

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = `tk-toast tk-toast--${kind}`;
  t.textContent = msg;
  els.toast.appendChild(t);
  requestAnimationFrame(() => t.classList.add("tk-toast--in"));
  setTimeout(() => {
    t.classList.remove("tk-toast--in");
    setTimeout(() => t.remove(), 300);
  }, 3600);
}

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** end_date inklusiv → FullCalendar all-day (end exklusiv) */
function inclusiveEndToFcEndYmd(ymd) {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return toYmd(d);
}

function rowToFcEvent(row) {
  const t = row.type;
  const col = TYPE_COLORS[t] || TYPE_COLORS.sonstiges;
  return {
    id: `db-${row.id}`,
    title: `${row.name} · ${TYPE_LABELS[t] || t}`,
    start: row.start_date,
    end: inclusiveEndToFcEndYmd(row.end_date),
    allDay: true,
    backgroundColor: col.bg,
    borderColor: col.bg,
    textColor: col.fg,
    extendedProps: {
      source: "db",
      rowId: row.id,
      type: t,
      name: row.name,
      note: row.note || "",
      startD: row.start_date,
      endD: row.end_date,
    },
  };
}

function applySearch() {
  const q = (els.search.value || "").trim().toLowerCase();
  searchQuery = q;
  calendar.getEvents().forEach((e) => {
    if (e.id && String(e.id).startsWith("nrw-")) {
      e.setProp("display", "auto");
      return;
    }
    const name = (e.extendedProps.name || e.title || "").toLowerCase();
    const vis = !q || name.includes(q);
    e.setProp("display", vis ? "auto" : "none");
  });
}

function closeModal(ov) {
  ov.classList.remove("is-open");
  ov.setAttribute("aria-hidden", "true");
}

function openCreateModal(preset) {
  els.formName.value = "";
  els.formType.value = "urlaub";
  els.formNote.value = "";
  if (preset && preset.start) {
    const s = preset.start;
    if (typeof s === "string" && s.length >= 10) {
      els.formStart.value = s.slice(0, 10);
      els.formEnd.value = (preset.end != null ? String(preset.end) : s).slice(0, 10);
    } else if (s instanceof Date) {
      const ymd = toYmd(s);
      els.formStart.value = ymd;
      els.formEnd.value = preset.end instanceof Date ? toYmd(preset.end) : ymd;
    }
  }
  if (els.formEnd.value < els.formStart.value) els.formEnd.value = els.formStart.value;
  els.modalOvl.classList.add("is-open");
  els.modalOvl.setAttribute("aria-hidden", "false");
  els.formName.focus();
}

function openDetailFromEvent(ev) {
  isNrwEvent = String(ev.id).startsWith("nrw-");
  if (isNrwEvent) {
    detailEventId = null;
    els.dName.textContent = "NRW (schreibgeschützt)";
    els.dType.textContent = ev.extendedProps.notiz || "Feiertag";
    const st = ev.start;
    const ymd = st
      ? st instanceof Date
        ? toYmd(st)
        : String(st).slice(0, 10)
      : "—";
    els.dRange.textContent = ymd;
    els.dNote.textContent = "NRW-Feiertag, nicht editierbar.";
    els.detailDelete.style.display = "none";
  } else {
    const ex = ev.extendedProps;
    detailEventId = ex.rowId;
    els.dName.textContent = ex.name || "—";
    els.dType.textContent = TYPE_LABELS[ex.type] || ex.type;
    els.dRange.textContent = `${ex.startD} → ${ex.endD}`;
    els.dNote.textContent = ex.note || "—";
    els.detailDelete.style.display = "inline-flex";
  }
  els.modalOvl2.classList.add("is-open");
  els.modalOvl2.setAttribute("aria-hidden", "false");
}

async function init() {
  els.cal = document.getElementById("calendar");
  els.toast = document.getElementById("toast-container");
  els.modalOvl = document.getElementById("modal-create");
  els.modalOvl2 = document.getElementById("modal-detail");
  els.formName = document.getElementById("f-name");
  els.formType = document.getElementById("f-type");
  els.formStart = document.getElementById("f-start");
  els.formEnd = document.getElementById("f-end");
  els.formNote = document.getElementById("f-note");
  els.dName = document.getElementById("d-name");
  els.dType = document.getElementById("d-type");
  els.dRange = document.getElementById("d-range");
  els.dNote = document.getElementById("d-note");
  els.search = document.getElementById("header-search");
  els.badge = document.getElementById("sync-badge");
  els.btnCreate = document.getElementById("btn-new-entry");
  els.btnViewMonth = document.getElementById("view-month");
  els.btnViewWeek = document.getElementById("view-week");
  els.btnViewYear = document.getElementById("view-year");
  els.detailDelete = document.getElementById("btn-delete-entry");

  if (!TEAM_KALENDER_API_URL || TEAM_KALENDER_API_URL.includes("<")) {
    toast("config.js: TEAM_KALENDER_API_URL prüfen", "err");
  }

  try {
    dbRows = await fetchAllEvents();
    els.badge.classList.remove("is-offline");
    els.badge.querySelector(".sync-label").textContent = "Online (Sync)";
  } catch (e) {
    console.error(e);
    toast("API: " + (e.message || "Fehler beim Laden"), "err");
  }

  const nrwEvents = getNrwFeiertageAsCalendarEvents().map((e) => ({
    ...e,
    backgroundColor: TYPE_COLORS.nrw.bg,
    borderColor: "#cbd5e1",
    textColor: TYPE_COLORS.nrw.fg,
  }));

  function rebuildDbEvents() {
    const events = (dbRows || []).map(rowToFcEvent);
    if (!calendar) return;
    const toRemove = calendar.getEvents().filter((e) => e.id && String(e.id).startsWith("db-"));
    toRemove.forEach((e) => e.remove());
    events.forEach((e) => calendar.addEvent(e));
    applySearch();
  }

  let syncViewButtons = () => void 0;

  calendar = new Calendar(els.cal, {
    plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin, multiMonthPlugin],
    locale: "de",
    timeZone: "local",
    initialView: "dayGridMonth",
    firstDay: 1,
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "",
    },
    height: "auto",
    selectable: true,
    selectMirror: true,
    unselectAuto: true,
    dayMaxEvents: 4,
    weekNumbers: true,
    weekText: "KW",
    multiMonthMaxColumns: 3,
    buttonText: {
      today: "Heute",
      month: "Monat",
      week: "Woche",
      year: "Jahr",
    },
    customButtons: {},
    eventSources: [
      {
        id: nrwSourceId,
        events: nrwEvents,
      },
    ],
    eventClick(info) {
      info.jsEvent.preventDefault();
      openDetailFromEvent(info.event);
    },
    dateClick(arg) {
      openCreateModal({ start: arg.date, end: arg.date });
    },
    select(info) {
      const sD = toYmd(info.start);
      const endExcl = new Date(info.end);
      endExcl.setDate(endExcl.getDate() - 1);
      const eD = toYmd(endExcl);
      openCreateModal({ start: sD, end: eD });
      info.view.calendar.unselect();
    },
    datesSet() {
      applySearch();
      syncViewButtons();
    },
  });

  syncViewButtons = function () {
    if (!calendar) return;
    const t = calendar.view.type;
    [els.btnViewMonth, els.btnViewWeek, els.btnViewYear].forEach((b) =>
      b.setAttribute("aria-pressed", "false")
    );
    if (t === "dayGridMonth") els.btnViewMonth.setAttribute("aria-pressed", "true");
    else if (t === "timeGridWeek") els.btnViewWeek.setAttribute("aria-pressed", "true");
    else if (t === "multiMonthYear") els.btnViewYear.setAttribute("aria-pressed", "true");
  };

  calendar.render();
  rebuildDbEvents();
  syncViewButtons();

  startEventPolling(
    {
      onData: (rows) => {
        dbRows = rows;
        rebuildDbEvents();
      },
      onStatus: (st) => {
        const online = st === "ok";
        els.badge.classList.toggle("is-offline", !online);
        els.badge.querySelector(".sync-label").textContent = online
          ? "Online (Sync)"
          : "Offline";
      },
    },
    4000
  );

  els.btnViewMonth.addEventListener("click", () => {
    calendar.changeView("dayGridMonth");
  });
  els.btnViewWeek.addEventListener("click", () => {
    calendar.changeView("timeGridWeek");
  });
  els.btnViewYear.addEventListener("click", () => {
    calendar.changeView("multiMonthYear");
  });

  els.btnCreate.addEventListener("click", () => {
    const now = new Date();
    const ymd = toYmd(now);
    openCreateModal({ start: ymd, end: ymd });
  });

  document.getElementById("m-cancel").addEventListener("click", () => {
    closeModal(els.modalOvl);
  });
  document.getElementById("m-close").addEventListener("click", () => {
    closeModal(els.modalOvl);
  });
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = els.formName.value.trim();
    const type = els.formType.value;
    const s = els.formStart.value;
    const e = els.formEnd.value;
    if (!name) {
      toast("Bitte Name ausfüllen", "err");
      return;
    }
    if (!s || !e) {
      toast("Start- und Enddatum setzen", "err");
      return;
    }
    if (e < s) {
      toast("Ende vor Start – prüfen", "err");
      return;
    }
    try {
      await insertEvent({
        name,
        type,
        start_date: s,
        end_date: e,
        note: els.formNote.value.trim() || null,
      });
      closeModal(els.modalOvl);
      toast("Eintrag gespeichert", "ok");
      dbRows = await fetchAllEvents();
      rebuildDbEvents();
    } catch (err) {
      console.error(err);
      toast(err.message || "Speichern fehlgeschlagen", "err");
    }
  });

  document.getElementById("d-close").addEventListener("click", () => {
    closeModal(els.modalOvl2);
  });
  document.getElementById("d-close-2").addEventListener("click", (e) => {
    e.stopPropagation();
    closeModal(els.modalOvl2);
  });
  els.modalOvl2.addEventListener("click", (e) => {
    if (e.target === els.modalOvl2) closeModal(els.modalOvl2);
  });
  els.modalOvl.addEventListener("click", (e) => {
    if (e.target === els.modalOvl) closeModal(els.modalOvl);
  });
  els.detailDelete.addEventListener("click", async () => {
    if (!detailEventId) return;
    try {
      await deleteEventById(detailEventId);
      closeModal(els.modalOvl2);
      toast("Eintrag gelöscht", "ok");
      dbRows = dbRows.filter((r) => r.id !== detailEventId);
      const ev = calendar.getEventById("db-" + detailEventId);
      if (ev) ev.remove();
    } catch (err) {
      console.error(err);
      toast(err.message || "Löschen fehlgeschlagen", "err");
    }
  });

  els.search.addEventListener("input", () => {
    applySearch();
  });
}

document.addEventListener("DOMContentLoaded", init);
