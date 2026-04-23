/**
 * ROOTS Team-Abwesenheitskalender – UI, FullCalendar, Modals, Custom-Select, Team-API
 */
import { TEAM_KALENDER_API_URL } from "./config.js";
import {
  fetchAllEvents,
  fetchMembers,
  insertEvent,
  deleteEventById,
  createMember,
  deleteMemberById,
  startEventPolling,
} from "./supabase-events.js";
import { getNrwFeiertageAsCalendarEvents } from "./nrw-feiertage.js";

const TYPE_LABELS = {
  urlaub: "Urlaub",
  krank: "Krank / krankheitsbedingt",
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

const SEL_NEW = "__new__";

/** Vorgegebene Anzeigereihenfolge, danach A–Z */
const PREFERRED_MEMBERS = ["Richard", "Manuel", "Rod", "Pano"];

function sortMembersList(rows) {
  const seen = new Set();
  const out = [];
  for (const n of PREFERRED_MEMBERS) {
    const f = (rows || []).find((m) => m.name === n);
    if (f) {
      out.push(f);
      seen.add(f.id);
    }
  }
  const rest = (rows || [])
    .filter((m) => !seen.has(m.id))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  return [...out, ...rest];
}

let calendar = null;
let dbRows = [];
let memberRows = [];
let searchQuery = "";
let nrwSourceId = "nrw-feiertage";
let memberMenuOpen = false;
/** @type {string | null} */
let formMemberId = null;

const els = {
  cal: null,
  toast: null,
  modalOvl: null,
  modalOvl2: null,
  modalTeam: null,
  formMemberTrigger: null,
  formMemberText: null,
  formMemberMenu: null,
  formNewWrap: null,
  formNewName: null,
  formNewAdd: null,
  formType: null,
  formTypeChips: null,
  formStart: null,
  formEnd: null,
  formNote: null,
  datePresets: null,
  dName: null,
  dType: null,
  dRange: null,
  dNote: null,
  search: null,
  badge: null,
  btnCreate: null,
  btnTeam: null,
  teamList: null,
  teamClose: null,
  teamClose2: null,
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

/** @param {string} ymd Lokal YYYY-MM-DD, @param {number} n Tage dazu */
function ymdAddDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + n);
  return toYmd(d);
}

/**
 * Dauer in Kalendertagen inkl. Start- und Endtag (1 Tag: nur Start).
 * @param {string} ymd
 * @param {number} inclusiveDays
 */
function setEndFromInclusiveDuration(ymd, inclusiveDays) {
  if (!ymd || !els.formEnd) return;
  const days = Math.max(1, Math.floor(inclusiveDays));
  els.formEnd.value = ymdAddDays(ymd, days - 1);
}

function inclusiveEndToFcEndYmd(ymd) {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return toYmd(d);
}

function rowToFcEvent(row) {
  const t = row.type === "homeoffice" ? "sonstiges" : row.type;
  const col = TYPE_COLORS[t] || TYPE_COLORS.sonstiges;
  const n = row.member_name || "—";
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
      type: t,
      name: n,
      note: row.note || "",
      startD: row.start_date,
      endD: row.end_date,
    },
  };
}

function applySearch() {
  if (!calendar) return;
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

function getMemberNameById(id) {
  const m = memberRows.find((x) => x.id === id);
  return m ? m.name : null;
}

function setFormMemberId(id) {
  formMemberId = id;
  if (!id) {
    els.formMemberText.textContent = "Teammitglied wählen";
    return;
  }
  if (id === SEL_NEW) {
    els.formMemberText.textContent = "Neuen Benutzer anlegen";
    return;
  }
  els.formMemberText.textContent = getMemberNameById(id) || "—";
}

function buildMemberOptions() {
  if (!els.formMemberMenu) return;
  els.formMemberMenu.innerHTML = "";
  (memberRows || []).forEach((m) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.className = "tk-select-option";
    li.dataset.id = m.id;
    li.textContent = m.name;
    if (formMemberId === m.id) li.setAttribute("aria-selected", "true");
    els.formMemberMenu.appendChild(li);
  });
  const liN = document.createElement("li");
  liN.setAttribute("role", "option");
  liN.className = "tk-select-option tk-select-option--new";
  liN.dataset.id = SEL_NEW;
  liN.innerHTML = '<i class="ri-user-add-line" aria-hidden="true"></i> Neuen Benutzer hinzufügen';
  els.formMemberMenu.appendChild(liN);
}

function openMemberMenu() {
  const wrap = document.getElementById("member-select");
  if (wrap) wrap.classList.add("is-menu-open");
  buildMemberOptions();
  memberMenuOpen = true;
  els.formMemberMenu.hidden = false;
  els.formMemberTrigger.setAttribute("aria-expanded", "true");
}

function closeMemberMenu() {
  const wrap = document.getElementById("member-select");
  if (wrap) wrap.classList.remove("is-menu-open");
  memberMenuOpen = false;
  if (els.formMemberMenu) els.formMemberMenu.hidden = true;
  if (els.formMemberTrigger) els.formMemberTrigger.setAttribute("aria-expanded", "false");
}

function renderTeamList() {
  if (!els.teamList) return;
  els.teamList.innerHTML = "";
  (memberRows || []).forEach((m) => {
    const li = document.createElement("li");
    li.className = "tk-team-row";
    li.innerHTML = `<span class="tk-team-name">${escapeHtml(m.name)}</span>
      <button type="button" class="tk-team-del btn-icon-danger" data-id="${m.id}" title="Entfernen">
        <i class="ri-delete-bin-line" aria-hidden="true"></i>
      </button>`;
    els.teamList.appendChild(li);
  });
  els.teamList.querySelectorAll(".tk-team-del").forEach((b) => {
    b.addEventListener("click", async () => {
      const id = b.getAttribute("data-id");
      if (!id) return;
      if (!confirm("Teammitglied wirklich löschen? (Nur möglich ohne zugehörige Einträge.)")) return;
      try {
        await deleteMemberById(id);
        memberRows = sortMembersList(await fetchMembers());
        renderTeamList();
        buildMemberOptions();
        if (formMemberId === id) {
          setFormMemberId(null);
        }
        toast("Teammitglied entfernt", "ok");
      } catch (e) {
        console.error(e);
        toast(e.message || "Löschen nicht möglich", "err");
      }
    });
  });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
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

function openCreateModal(preset) {
  formMemberId = null;
  setFormMemberId(null);
  buildMemberOptions();
  els.formNewWrap.hidden = true;
  if (els.formNewName) els.formNewName.value = "";
  closeMemberMenu();
  setFormTypeValue("urlaub");
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
  els.formMemberTrigger.focus();
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
  els.modalTeam = document.getElementById("modal-team");
  els.formMemberTrigger = document.getElementById("f-member-trigger");
  els.formMemberText = document.getElementById("f-member-text");
  els.formMemberMenu = document.getElementById("f-member-menu");
  els.formNewWrap = document.getElementById("f-new-member-wrap");
  els.formNewName = document.getElementById("f-new-member-name");
  els.formNewAdd = document.getElementById("f-new-member-add");
  els.formType = document.getElementById("f-type");
  els.formTypeChips = document.getElementById("f-type-chips");
  els.formStart = document.getElementById("f-start");
  els.formEnd = document.getElementById("f-end");
  els.formNote = document.getElementById("f-note");
  els.datePresets = document.getElementById("f-date-presets");
  els.dName = document.getElementById("d-name");
  els.dType = document.getElementById("d-type");
  els.dRange = document.getElementById("d-range");
  els.dNote = document.getElementById("d-note");
  els.search = document.getElementById("header-search");
  els.badge = document.getElementById("sync-badge");
  els.btnCreate = document.getElementById("btn-new-entry");
  els.btnTeam = document.getElementById("btn-team");
  els.teamList = document.getElementById("team-list");
  els.teamClose = document.getElementById("team-close");
  els.teamClose2 = document.getElementById("team-close-2");
  els.btnViewMonth = document.getElementById("view-month");
  els.btnViewWeek = document.getElementById("view-week");
  els.btnViewYear = document.getElementById("view-year");
  els.detailDelete = document.getElementById("btn-delete-entry");

  if (els.formType) setFormTypeValue(els.formType.value);

  if (els.formTypeChips) {
    els.formTypeChips.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest(".tk-chip[data-type]");
      if (!btn) return;
      setFormTypeValue(btn.getAttribute("data-type") || "urlaub");
    });
  }
  if (els.datePresets) {
    els.datePresets.addEventListener("click", (e) => {
      const b = e.target && e.target.closest("button[data-inclusivedays]");
      if (!b) return;
      if (!els.formStart || !els.formStart.value) {
        toast("Zuerst ein Startdatum wählen", "err");
        return;
      }
      const d = parseInt(b.getAttribute("data-inclusivedays") || "1", 10);
      setEndFromInclusiveDuration(els.formStart.value, d);
    });
  }
  if (els.formStart) {
    els.formStart.addEventListener("change", () => {
      if (els.formEnd && els.formStart.value && els.formEnd.value < els.formStart.value) {
        els.formEnd.value = els.formStart.value;
      }
    });
  }

  if (!TEAM_KALENDER_API_URL || TEAM_KALENDER_API_URL.includes("<")) {
    toast("config.js: TEAM_KALENDER_API_URL prüfen", "err");
  }

  try {
    const [ev, mem] = await Promise.all([fetchAllEvents(), fetchMembers()]);
    dbRows = ev;
    memberRows = sortMembersList(mem);
    els.badge.classList.remove("offline", "online");
    els.badge.classList.add("online");
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

  const FC = globalThis.FullCalendar;
  if (!FC || typeof FC.Calendar !== "function") {
    toast("FullCalendar fehlt: index.html muss fullcalendar index.global.min.js VOR app.js laden.", "err");
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
    weekNumbers: false,
    views: {
      dayGridWeek: { dayMaxEvents: 5 },
      multiMonthYear: {
        multiMonthMaxColumns: 3,
        multiMonthMinWidth: 200,
      },
    },
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
    toast("Kalender-Darstellung fehlgeschlagen. Eintrag-Button trotzdem nutzbar.", "err");
  }
  renderTeamList();
  rebuildDbEvents();
  buildMemberOptions();
  syncViewButtons();

  startEventPolling(
    {
      onData: ({ events, members }) => {
        dbRows = events;
        memberRows = sortMembersList(members);
        rebuildDbEvents();
        renderTeamList();
        if (memberMenuOpen) buildMemberOptions();
      },
      onStatus: (st) => {
        const online = st === "ok";
        els.badge.classList.remove("offline", "online");
        els.badge.classList.add(online ? "online" : "offline");
        els.badge.querySelector(".sync-label").textContent = online
          ? "Online (Sync)"
          : "Offline";
      },
    },
    4000,
  );

  els.btnViewMonth.addEventListener("click", () => {
    if (calendar) calendar.changeView("dayGridMonth");
  });
  els.btnViewWeek.addEventListener("click", () => {
    if (calendar) calendar.changeView("dayGridWeek");
  });
  els.btnViewYear.addEventListener("click", () => {
    if (calendar) calendar.changeView("multiMonthYear");
  });

  els.btnCreate.addEventListener("click", () => {
    const now = new Date();
    const ymd = toYmd(now);
    openCreateModal({ start: ymd, end: ymd });
  });

  if (els.btnTeam) {
    els.btnTeam.addEventListener("click", () => {
      renderTeamList();
      els.modalTeam.classList.add("is-open");
      els.modalTeam.setAttribute("aria-hidden", "false");
    });
  }
  if (els.teamClose)
    els.teamClose.addEventListener("click", () => {
      closeModal(els.modalTeam);
    });
  if (els.teamClose2)
    els.teamClose2.addEventListener("click", () => {
      closeModal(els.modalTeam);
    });
  if (els.modalTeam)
    els.modalTeam.addEventListener("click", (e) => {
      if (e.target === els.modalTeam) closeModal(els.modalTeam);
    });

  document.getElementById("m-cancel").addEventListener("click", () => {
    closeMemberMenu();
    closeModal(els.modalOvl);
  });
  document.getElementById("m-close").addEventListener("click", () => {
    closeMemberMenu();
    closeModal(els.modalOvl);
  });
  document.getElementById("m-save").addEventListener("click", async () => {
    const type = els.formType.value;
    const s = els.formStart.value;
    const e = els.formEnd.value;
    let mid = formMemberId;
    if (!mid) {
      toast("Bitte Teammitglied wählen", "err");
      return;
    }
    if (mid === SEL_NEW) {
      const nn = (els.formNewName && els.formNewName.value.trim()) || "";
      if (!nn) {
        toast("Bitte Namen für neues Teammitglied eingeben", "err");
        return;
      }
      try {
        const created = await createMember(nn);
        memberRows = sortMembersList(await fetchMembers());
        buildMemberOptions();
        renderTeamList();
        mid = created.id;
        setFormMemberId(mid);
        els.formNewWrap.hidden = true;
      } catch (err) {
        console.error(err);
        toast(err.message || "Anlegen fehlgeschlagen", "err");
        return;
      }
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
        member_id: mid,
        type,
        start_date: s,
        end_date: e,
        note: els.formNote.value.trim() || null,
      });
      closeMemberMenu();
      closeModal(els.modalOvl);
      toast("Eintrag gespeichert", "ok");
      dbRows = await fetchAllEvents();
      memberRows = sortMembersList(await fetchMembers());
      rebuildDbEvents();
      renderTeamList();
    } catch (err) {
      console.error(err);
      toast(err.message || "Speichern fehlgeschlagen", "err");
    }
  });

  if (els.formMemberTrigger) {
    els.formMemberTrigger.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (memberMenuOpen) closeMemberMenu();
      else openMemberMenu();
    });
  }
  if (els.formMemberMenu) {
    els.formMemberMenu.addEventListener("click", (e) => {
      const li = e.target && e.target.closest("li.tk-select-option");
      if (!li || !els.formMemberMenu.contains(li)) return;
      e.stopPropagation();
      const id = li.dataset.id;
      if (id === SEL_NEW) {
        setFormMemberId(SEL_NEW);
        els.formNewWrap.hidden = false;
        if (els.formNewName) {
          els.formNewName.value = "";
          els.formNewName.focus();
        }
        closeMemberMenu();
        return;
      }
      formMemberId = id;
      setFormMemberId(id);
      els.formNewWrap.hidden = true;
      closeMemberMenu();
    });
  }
  if (els.formNewAdd) {
    els.formNewAdd.addEventListener("click", async () => {
      const nn = (els.formNewName && els.formNewName.value.trim()) || "";
      if (!nn) {
        toast("Namen eingeben", "err");
        return;
      }
      try {
        const created = await createMember(nn);
        memberRows = sortMembersList(await fetchMembers());
        formMemberId = created.id;
        setFormMemberId(created.id);
        buildMemberOptions();
        els.formNewWrap.hidden = true;
        renderTeamList();
        toast("Teammitglied angelegt", "ok");
      } catch (err) {
        console.error(err);
        toast(err.message || "Anlegen fehlgeschlagen", "err");
      }
    });
  }
  document.addEventListener("click", (e) => {
    if (e.target && typeof e.target.closest === "function" && e.target.closest("#member-select")) return;
    closeMemberMenu();
  });
  if (els.modalOvl) {
    els.modalOvl.addEventListener("click", (e) => {
      if (e.target === els.modalOvl) {
        closeMemberMenu();
        closeModal(els.modalOvl);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !els.modalOvl.classList.contains("is-open")) return;
      e.preventDefault();
      if (memberMenuOpen) {
        closeMemberMenu();
        return;
      }
      closeModal(els.modalOvl);
    });
  }

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
  els.detailDelete.addEventListener("click", async () => {
    if (!detailEventId) return;
    try {
      await deleteEventById(detailEventId);
      closeModal(els.modalOvl2);
      toast("Eintrag gelöscht", "ok");
      dbRows = dbRows.filter((r) => r.id !== detailEventId);
      if (!calendar) return;
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
