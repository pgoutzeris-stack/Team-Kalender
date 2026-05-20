/**
 * ROOTS Team-Abwesenheitskalender
 */
import { TEAM_KALENDER_API_URL } from "./config.js";
import {
  fetchAllEvents,
  fetchNrwHolidays,
  ensureMemberForUser,
  insertEvent,
  updateEvent,
  deleteEventById,
} from "./supabase-events.js";

const TYPE_LABELS = {
  urlaub: "Urlaub",
  krank: "Krank",
  dienstreise: "Dienstreise",
  sonstiges: "Sonstiges",
};

const TYPE_COLORS = {
  urlaub: { bg: "#206efb", fg: "#ffffff" },
  krank: { bg: "#dc2626", fg: "#ffffff" },
  dienstreise: { bg: "#f59e0b", fg: "#0f172a" },
  sonstiges: { bg: "#475569", fg: "#ffffff" },
  nrw: { bg: "#e2e8f0", fg: "#0f172a" },
};

let calendar = null;
let dbRows = [];
let searchQuery = "";
/** @type {Set<string>} */
let nrwDateSet = new Set();
let nrwHolidayRows = [];
let currentMemberId = null;
let currentMemberName = "";
let draftEventId = null;
let autosaveTimer = null;
let autosaveBusy = false;

const els = {
  cal: null,
  toast: null,
  modalOvl: null,
  formType: null,
  formTypeChips: null,
  formStart: null,
  formEnd: null,
  formNote: null,
  datePresets: null,
  formMemberLabel: null,
  autosaveStatus: null,
  modalTitle: null,
  btnDeleteEntry: null,
  search: null,
  btnCreate: null,
  btnViewMonth: null,
  btnViewWeek: null,
  btnViewYear: null,
};

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

function setAutosaveStatus(text, state = "") {
  if (!els.autosaveStatus) return;
  els.autosaveStatus.textContent = text;
  els.autosaveStatus.dataset.state = state;
}

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MONTHS_DE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

function ymdFromParts(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fillDayOptions(dSel, y, m, prefer) {
  if (!dSel) return 1;
  const maxD = daysInMonth(y, m);
  const want = prefer != null && prefer > 0 ? prefer : 1;
  const use = want > maxD ? maxD : want;
  dSel.innerHTML = "";
  for (let i = 1; i <= maxD; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = String(i);
    dSel.appendChild(o);
  }
  dSel.value = String(use);
  return use;
}

function buildYearOptions(ySel, centerY) {
  if (!ySel) return;
  const from = (centerY || new Date().getFullYear()) - 2;
  const to = from + 7;
  ySel.innerHTML = "";
  for (let y = from; y <= to; y++) {
    const o = document.createElement("option");
    o.value = String(y);
    o.textContent = String(y);
    ySel.appendChild(o);
  }
}

function buildMonthOptions(mSel) {
  if (!mSel) return;
  mSel.innerHTML = "";
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement("option");
    o.value = String(m);
    o.textContent = MONTHS_DE[m - 1];
    mSel.appendChild(o);
  }
}

function readYmdFromCombos(idBase) {
  const dEl = document.getElementById(`${idBase}-d`);
  const mEl = document.getElementById(`${idBase}-m`);
  const yEl = document.getElementById(`${idBase}-y`);
  if (!dEl || !mEl || !yEl) return "";
  const y = parseInt(yEl.value, 10);
  const m = parseInt(mEl.value, 10);
  const d = parseInt(dEl.value, 10);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return "";
  return ymdFromParts(y, m, d);
}

function setCombosFromYmd(idBase, ymd) {
  if (!ymd || ymd.length < 10) return;
  const dEl = document.getElementById(`${idBase}-d`);
  const mEl = document.getElementById(`${idBase}-m`);
  const yEl = document.getElementById(`${idBase}-y`);
  const hEl = document.getElementById(idBase);
  if (!dEl || !mEl || !yEl) return;
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(5, 7), 10);
  const d = parseInt(ymd.slice(8, 10), 10);
  if (yEl.querySelector(`option[value="${y}"]`) == null) {
    const o = document.createElement("option");
    o.value = String(y);
    o.textContent = String(y);
    yEl.appendChild(o);
  }
  yEl.value = String(y);
  mEl.value = String(m);
  fillDayOptions(dEl, y, m, d);
  if (hEl) hEl.value = ymdFromParts(y, m, parseInt(dEl.value, 10));
}

function ymdAddDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + n);
  return toYmd(d);
}

function setEndFromInclusiveDuration(ymd, inclusiveDays) {
  if (!ymd || !els.formEnd) return;
  const days = Math.max(1, Math.floor(inclusiveDays));
  const endY = ymdAddDays(ymd, days - 1);
  els.formEnd.value = endY;
  setCombosFromYmd("f-end", endY);
}

function inclusiveEndToFcEndYmd(ymd) {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return toYmd(d);
}

function rowToFcEvent(row) {
  const t = row.type === "homeoffice" ? "sonstiges" : row.type;
  const col = TYPE_COLORS[t] || TYPE_COLORS.sonstiges;
  const n = row.member_name || currentMemberName || "—";
  return {
    id: `db-${row.id}`,
    title: `${n} · ${TYPE_LABELS[t] || t}`,
    start: row.start_date,
    end: inclusiveEndToFcEndYmd(row.end_date),
    allDay: true,
    backgroundColor: col.bg,
    borderColor: col.bg,
    textColor: col.fg,
    extendedProps: {
      source: "db",
      rowId: row.id,
      memberId: row.member_id,
      type: t,
      name: n,
      note: row.note || "",
      startD: row.start_date,
      endD: row.end_date,
    },
  };
}

function nrwRowsToFcEvents(rows) {
  return (rows || []).map((h) => ({
    id: `nrw-${h.holiday_date}`,
    title: h.label,
    start: h.holiday_date,
    allDay: true,
    display: "background",
    backgroundColor: TYPE_COLORS.nrw.bg,
    borderColor: "#cbd5e1",
    textColor: TYPE_COLORS.nrw.fg,
    classNames: ["fc-event-nrw", "event-type-nrw"],
    extendedProps: { type: "nrw", source: "nrw", notiz: h.label },
  }));
}

function applySearch() {
  if (!calendar) return;
  const q = (els.search.value || "").trim().toLowerCase();
  searchQuery = q;
  calendar.getEvents().forEach((e) => {
    if (e.id && String(e.id).startsWith("nrw-")) return;
    const name = (e.extendedProps.name || e.title || "").toLowerCase();
    const vis = !q || name.includes(q);
    e.setProp("display", vis ? "auto" : "none");
  });
}

function closeModal(ov) {
  ov.classList.remove("is-open");
  ov.setAttribute("aria-hidden", "true");
  draftEventId = null;
  setAutosaveStatus("");
}

function setFormTypeValue(type) {
  if (!els.formType) return;
  const t = type && Object.prototype.hasOwnProperty.call(TYPE_LABELS, type) ? type : "urlaub";
  els.formType.value = t;
  if (els.formTypeChips) {
    els.formTypeChips.querySelectorAll(".tk-chip").forEach((btn) => {
      const on = (btn.getAttribute("data-type") || "") === t;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
}

function readFormPayload() {
  const s = readYmdFromCombos("f-start") || (els.formStart && els.formStart.value) || "";
  const e = readYmdFromCombos("f-end") || (els.formEnd && els.formEnd.value) || "";
  return {
    type: els.formType.value,
    start_date: s,
    end_date: e,
    note: els.formNote.value.trim() || null,
  };
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => persistEntry(), 650);
}

async function persistEntry() {
  if (!currentMemberId || autosaveBusy) return;
  const { type, start_date, end_date, note } = readFormPayload();
  if (!start_date || !end_date || end_date < start_date) {
    setAutosaveStatus("Zeitraum prüfen", "err");
    return;
  }
  autosaveBusy = true;
  setAutosaveStatus("Speichert…", "busy");
  try {
    let row;
    if (draftEventId) {
      row = await updateEvent(draftEventId, { type, start_date, end_date, note });
    } else {
      row = await insertEvent({
        member_id: currentMemberId,
        type,
        start_date,
        end_date,
        note,
      });
      draftEventId = row.id;
    }
    const idx = dbRows.findIndex((r) => r.id === row.id);
    if (idx >= 0) dbRows[idx] = row;
    else dbRows.push(row);
    rebuildDbEvents();
    setAutosaveStatus("Gespeichert", "ok");
  } catch (err) {
    console.error(err);
    setAutosaveStatus("Speichern fehlgeschlagen", "err");
    toast(err.message || "Speichern fehlgeschlagen", "err");
  } finally {
    autosaveBusy = false;
  }
}

function openEntryModal(preset, editRow) {
  if (!currentMemberId) {
    toast("Profil konnte nicht geladen werden", "err");
    return;
  }
  draftEventId = editRow ? editRow.id : null;
  if (els.formMemberLabel) {
    els.formMemberLabel.textContent = currentMemberName || "Dein Kalender";
  }
  if (els.modalTitle) {
    els.modalTitle.textContent = editRow ? "Eintrag bearbeiten" : "Eintrag erstellen";
  }
  if (els.btnDeleteEntry) {
    els.btnDeleteEntry.hidden = !editRow;
  }
  setFormTypeValue(editRow ? editRow.type : "urlaub");
  els.formNote.value = editRow ? editRow.note || "" : "";

  let startYmd = toYmd(new Date());
  let endYmd = startYmd;
  if (editRow) {
    startYmd = editRow.start_date;
    endYmd = editRow.end_date;
  } else if (preset && preset.start) {
    const s = preset.start;
    if (typeof s === "string" && s.length >= 10) {
      startYmd = s.slice(0, 10);
      endYmd = (preset.end != null ? String(preset.end) : s).slice(0, 10);
    } else if (s instanceof Date) {
      startYmd = toYmd(s);
      endYmd = preset.end instanceof Date ? toYmd(preset.end) : startYmd;
    }
  }
  els.formStart.value = startYmd;
  els.formEnd.value = endYmd;
  setCombosFromYmd("f-start", startYmd);
  setCombosFromYmd("f-end", endYmd);
  setAutosaveStatus(editRow ? "" : "Änderungen werden automatisch gespeichert");
  els.modalOvl.classList.add("is-open");
  els.modalOvl.setAttribute("aria-hidden", "false");
  if (!editRow) scheduleAutosave();
}

function waitForRootsUser(maxMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.RootsUser?._uid && window.RootsUser?._p) resolve(window.RootsUser);
      else if (Date.now() - t0 > maxMs) resolve(null);
      else setTimeout(tick, 120);
    };
    tick();
  });
}

async function resolveCurrentMember() {
  const ru = await waitForRootsUser();
  if (!ru?._uid) throw new Error("Nicht angemeldet");
  const name = (ru._p.full_name || ru._p.email || "Nutzer").trim();
  const m = await ensureMemberForUser(ru._uid, name);
  currentMemberId = m.id;
  currentMemberName = m.name || name;
}

function rebuildDbEvents() {
  if (!calendar) return;
  const events = (dbRows || []).map(rowToFcEvent);
  calendar.getEvents().filter((e) => e.id && String(e.id).startsWith("db-")).forEach((e) => e.remove());
  events.forEach((e) => calendar.addEvent(e));
  applySearch();
}

function rebuildNrwEvents() {
  if (!calendar) return;
  calendar.getEvents().filter((e) => e.id && String(e.id).startsWith("nrw-")).forEach((e) => e.remove());
  nrwRowsToFcEvents(nrwHolidayRows).forEach((e) => calendar.addEvent(e));
}

async function reloadEvents() {
  dbRows = await fetchAllEvents();
  rebuildDbEvents();
}

async function init() {
  els.cal = document.getElementById("calendar");
  els.toast = document.getElementById("toast-container");
  els.modalOvl = document.getElementById("modal-create");
  els.formType = document.getElementById("f-type");
  els.formTypeChips = document.getElementById("f-type-chips");
  els.formStart = document.getElementById("f-start");
  els.formEnd = document.getElementById("f-end");
  els.formNote = document.getElementById("f-note");
  els.datePresets = document.getElementById("f-date-presets");
  els.formMemberLabel = document.getElementById("f-member-label");
  els.autosaveStatus = document.getElementById("f-autosave-status");
  els.modalTitle = document.getElementById("m-title");
  els.btnDeleteEntry = document.getElementById("btn-delete-entry");
  els.search = document.getElementById("header-search");
  els.btnCreate = document.getElementById("btn-new-entry");
  els.btnViewMonth = document.getElementById("view-month");
  els.btnViewWeek = document.getElementById("view-week");
  els.btnViewYear = document.getElementById("view-year");

  if (els.formType) setFormTypeValue(els.formType.value);

  if (els.formTypeChips) {
    els.formTypeChips.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest(".tk-chip[data-type]");
      if (!btn) return;
      setFormTypeValue(btn.getAttribute("data-type") || "urlaub");
      scheduleAutosave();
    });
  }
  if (els.datePresets) {
    els.datePresets.addEventListener("click", (e) => {
      const b = e.target && e.target.closest("button[data-inclusivedays]");
      if (!b) return;
      const s = readYmdFromCombos("f-start") || (els.formStart && els.formStart.value) || "";
      if (!s) {
        toast("Zuerst ein Startdatum wählen", "err");
        return;
      }
      setEndFromInclusiveDuration(s, parseInt(b.getAttribute("data-inclusivedays") || "1", 10));
      scheduleAutosave();
    });
  }
  if (els.formNote) els.formNote.addEventListener("input", scheduleAutosave);

  (function initDateCombos() {
    const yNow = new Date().getFullYear();
    buildYearOptions(document.getElementById("f-start-y"), yNow);
    buildYearOptions(document.getElementById("f-end-y"), yNow);
    buildMonthOptions(document.getElementById("f-start-m"));
    buildMonthOptions(document.getElementById("f-end-m"));
    const todayYmd = toYmd(new Date());
    if (els.formStart) {
      if (!els.formStart.value) els.formStart.value = todayYmd;
      setCombosFromYmd("f-start", els.formStart.value);
    }
    if (els.formEnd) {
      if (!els.formEnd.value) els.formEnd.value = todayYmd;
      setCombosFromYmd("f-end", els.formEnd.value);
    }
    function handleDatePartChange(idBase) {
      const mEl = document.getElementById(`${idBase}-m`);
      const yEl = document.getElementById(`${idBase}-y`);
      const dEl = document.getElementById(`${idBase}-d`);
      if (!mEl || !yEl || !dEl) return;
      const y = parseInt(yEl.value, 10);
      const m = parseInt(mEl.value, 10);
      fillDayOptions(dEl, y, m, parseInt(dEl.value, 10));
      const h = document.getElementById(idBase);
      if (h) h.value = readYmdFromCombos(idBase) || h.value;
      if (idBase === "f-start" && els.formStart && els.formEnd && els.formStart.value > els.formEnd.value) {
        els.formEnd.value = els.formStart.value;
        setCombosFromYmd("f-end", els.formEnd.value);
      }
      scheduleAutosave();
    }
    ["f-start", "f-end"].forEach((idBase) => {
      ["d", "m", "y"].forEach((p) => {
        const el = document.getElementById(`${idBase}-${p}`);
        if (el) el.addEventListener("change", () => handleDatePartChange(idBase));
      });
    });
  })();

  if (!TEAM_KALENDER_API_URL || TEAM_KALENDER_API_URL.includes("<")) {
    toast("config.js: TEAM_KALENDER_API_URL prüfen", "err");
    return;
  }

  try {
    await resolveCurrentMember();
    const [ev, nrw] = await Promise.all([fetchAllEvents(), fetchNrwHolidays()]);
    dbRows = ev || [];
    nrwHolidayRows = nrw || [];
    nrwDateSet = new Set(nrwHolidayRows.map((h) => h.holiday_date));
  } catch (e) {
    console.error(e);
    toast("API: " + (e.message || "Fehler beim Laden"), "err");
  }

  const FC = globalThis.FullCalendar;
  if (!FC || typeof FC.Calendar !== "function") {
    toast("FullCalendar fehlt", "err");
    return;
  }

  let plugins = Array.isArray(FC.globalPlugins) ? FC.globalPlugins : [];
  if (plugins.length === 0 && FC.dayGridPlugin) {
    plugins = [FC.dayGridPlugin, FC.interactionPlugin, FC.multiMonthPlugin].filter(Boolean);
  }

  let syncViewButtons = () => void 0;

  calendar = new FC.Calendar(els.cal, {
    ...(plugins.length ? { plugins } : {}),
    locale: "de",
    timeZone: "local",
    initialView: "dayGridMonth",
    firstDay: 1,
    headerToolbar: { left: "prev,next today", center: "title", right: "" },
    height: "auto",
    selectable: true,
    selectMirror: true,
    unselectAuto: true,
    dayMaxEvents: 4,
    weekNumbers: false,
    views: {
      dayGridWeek: { dayMaxEvents: 5 },
      multiMonthYear: { multiMonthMaxColumns: 3, multiMonthMinWidth: 200 },
    },
    buttonText: { today: "Heute" },
    dayCellClassNames(arg) {
      const ymd = toYmd(arg.date);
      return nrwDateSet.has(ymd) ? ["tk-day-nrw"] : [];
    },
    eventClick(info) {
      info.jsEvent.preventDefault();
      if (String(info.event.id).startsWith("nrw-")) {
        toast(info.event.title || "NRW-Feiertag", "ok");
        return;
      }
      const row = dbRows.find((r) => r.id === info.event.extendedProps.rowId);
      if (!row) return;
      if (row.member_id !== currentMemberId) {
        toast("Nur eigene Einträge können bearbeitet werden", "err");
        return;
      }
      openEntryModal(null, row);
    },
    dateClick(arg) {
      openEntryModal({ start: arg.date, end: arg.date });
    },
    select(info) {
      const sD = toYmd(info.start);
      const endExcl = new Date(info.end);
      endExcl.setDate(endExcl.getDate() - 1);
      openEntryModal({ start: sD, end: toYmd(endExcl) });
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
      b.setAttribute("aria-pressed", "false"),
    );
    if (t === "dayGridMonth") els.btnViewMonth.setAttribute("aria-pressed", "true");
    else if (t === "dayGridWeek") els.btnViewWeek.setAttribute("aria-pressed", "true");
    else if (t === "multiMonthYear") els.btnViewYear.setAttribute("aria-pressed", "true");
  };

  try {
    calendar.render();
  } catch (err) {
    console.error(err);
    toast("Kalender-Darstellung fehlgeschlagen", "err");
  }
  rebuildNrwEvents();
  rebuildDbEvents();
  syncViewButtons();

  els.btnViewMonth.addEventListener("click", () => calendar.changeView("dayGridMonth"));
  els.btnViewWeek.addEventListener("click", () => calendar.changeView("dayGridWeek"));
  els.btnViewYear.addEventListener("click", () => calendar.changeView("multiMonthYear"));

  els.btnCreate.addEventListener("click", () => {
    openEntryModal({ start: toYmd(new Date()), end: toYmd(new Date()) });
  });

  document.getElementById("m-cancel").addEventListener("click", () => closeModal(els.modalOvl));
  document.getElementById("m-close").addEventListener("click", () => closeModal(els.modalOvl));
  if (els.modalOvl) {
    els.modalOvl.addEventListener("click", (e) => {
      if (e.target === els.modalOvl) closeModal(els.modalOvl);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !els.modalOvl.classList.contains("is-open")) return;
      e.preventDefault();
      closeModal(els.modalOvl);
    });
  }

  if (els.btnDeleteEntry) {
    els.btnDeleteEntry.addEventListener("click", async () => {
      if (!draftEventId) return;
      if (!confirm("Eintrag wirklich löschen?")) return;
      try {
        await deleteEventById(draftEventId);
        dbRows = dbRows.filter((r) => r.id !== draftEventId);
        rebuildDbEvents();
        closeModal(els.modalOvl);
        toast("Eintrag gelöscht", "ok");
      } catch (err) {
        toast(err.message || "Löschen fehlgeschlagen", "err");
      }
    });
  }

  els.search.addEventListener("input", applySearch);
}

document.addEventListener("DOMContentLoaded", init);
