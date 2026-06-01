/**
 * ROOTS Team-Abwesenheitskalender
 */
import { TEAM_KALENDER_API_URL } from "./config.js";
import {
  fetchAllEvents,
  fetchTeamMembers,
  fetchNrwHolidays,
  ensureMemberForUser,
  insertEvent,
  updateEvent,
  deleteEventById,
  initTeamKalenderApi,
} from "./supabase-events.js";

const TYPE_LABELS = {
  urlaub: "Urlaub",
  krank: "Krank",
  dienstreise: "Dienstreise",
  sonstiges: "Sonstiges",
  betriebsferien: "Betriebsferien",
};

const TYPE_COLORS = {
  urlaub: { bg: "#16a34a", fg: "#ffffff" },
  krank: { bg: "#dc2626", fg: "#ffffff" },
  dienstreise: { bg: "#f59e0b", fg: "#0f172a" },
  sonstiges: { bg: "#475569", fg: "#ffffff" },
  betriebsferien: { bg: "#206efb", fg: "#ffffff" },
  nrw: { bg: "#e2e8f0", fg: "#0f172a" },
};

const DAY_PART_LABELS = {
  full: "Ganztägig",
  am: "Vormittag",
  pm: "Nachmittag",
};

let calendar = null;
let dbRows = [];
let searchQuery = "";
let searchMatches = [];
/** @type {Set<string>} */
let spotlightDates = new Set();
let searchRenderTimer = null;
/** @type {Set<string>} */
let nrwDateSet = new Set();
let nrwHolidayRows = [];
let currentMemberId = null;
let currentMemberName = "";
let currentMemberKuerzel = "";
let isAdminUser = false;
let draftEventId = null;
let saveBusy = false;
let teamMembers = [];
/** @type {Set<string>} */
let selectedMemberIds = new Set();

const els = {
  cal: null,
  toast: null,
  modalOvl: null,
  formType: null,
  formTypeChips: null,
  formStart: null,
  formEnd: null,
  formDayPart: null,
  formDayPartChips: null,
  formSonstigesWrap: null,
  formSonstigesSuffix: null,
  formNamePrefix: null,
  formNote: null,
  autosaveStatus: null,
  modalTitle: null,
  btnDeleteEntry: null,
  btnExportEntry: null,
  btnDone: null,
  exportOvl: null,
  exportClose: null,
  exportBox: null,
  search: null,
  btnCreate: null,
  btnViewMonth: null,
  btnViewYear: null,
  urlaubNotice: null,
  urlaubNoticeText: null,
  entryFormMain: null,
  formTypeRow: null,
  btnOpenUrlaubsplanung: null,
  searchSpotlight: null,
  memberFilterList: null,
  memberSelectAll: null,
  memberSelectNone: null,
};

const URLAUB_BLOCK_MSG =
  "Urlaub bitte über die Urlaubsplanung beantragen. Nach Genehmigung erscheint er automatisch im Kalender.";

function openUrlaubsplanung() {
  const ORIGIN = "https://pgoutzeris-stack.github.io";
  closeModal(els.modalOvl);
  if (window.parent !== window) {
    window.parent.postMessage({ type: "roots-open-view", view: "vacation" }, ORIGIN);
    return;
  }
  window.top.location.href = `${ORIGIN}/ROOTS_Intranet/#vacation`;
}

function showUrlaubNotice(show, message) {
  if (els.urlaubNotice) els.urlaubNotice.hidden = !show;
  if (els.urlaubNoticeText && message) {
    els.urlaubNoticeText.innerHTML = message;
  }
  if (els.formTypeRow) els.formTypeRow.hidden = show;
  if (els.entryFormMain) els.entryFormMain.hidden = show;
  if (els.btnDeleteEntry && show) els.btnDeleteEntry.hidden = true;
  if (els.btnDone && show) els.btnDone.hidden = true;
}

function deriveKuerzel(name, stored) {
  const k = (stored || "").trim().toUpperCase();
  if (k.length >= 2) return k.slice(0, 4);
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (parts[0]?.slice(0, 2) || "??").toUpperCase();
}

function memberKuerzel() {
  const ru = window.RootsUser?._p;
  const fromProfile = ru?.kuerzel;
  if (fromProfile) return deriveKuerzel(currentMemberName, fromProfile);
  return deriveKuerzel(currentMemberName, currentMemberKuerzel);
}

function refreshAdminState() {
  isAdminUser = window.RootsUser?._p?.app_role === "admin";
}

function isApprovedUrlaubEntry(row) {
  return Boolean(row?.type === "urlaub" && row?.is_approved_urlaub);
}

function isSystemEntry(row) {
  return Boolean(row?.is_system || String(row?.note || "").includes("AUTO:roots_closure"));
}

function isReadOnlyEntry(row) {
  if (!row) return false;
  if (isSystemEntry(row)) return true;
  if (isApprovedUrlaubEntry(row)) return true;
  if (row.type === "urlaub" && !isAdminUser) return true;
  return false;
}

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

function memberDisplayName() {
  return (currentMemberName || "Nutzer").trim();
}

function buildAutoTitle(type, sonstigesSuffix = "") {
  const kz = memberKuerzel();
  if (type === "sonstiges") {
    const suffix = (sonstigesSuffix || "").trim();
    return suffix ? `${kz}: ${suffix}` : "";
  }
  const label = TYPE_LABELS[type] || type;
  return `${kz}: ${label}`;
}

function parseSonstigesSuffix(storedTitle) {
  const kz = memberKuerzel();
  const t = (storedTitle || "").trim();
  if (!t) return "";
  const prefix = `${kz}: `;
  if (t.toUpperCase().startsWith(prefix.toUpperCase())) {
    return t.slice(prefix.length).trim();
  }
  const name = memberDisplayName();
  const legacyName = `${name} `;
  if (t.toLowerCase().startsWith(legacyName.toLowerCase())) {
    return t.slice(legacyName.length).trim();
  }
  const legacy = `${name} · ${TYPE_LABELS.sonstiges}`;
  if (t === legacy) return "";
  return t;
}

function normalizeDayPart(value) {
  return value === "am" || value === "pm" ? value : "full";
}

function dayPartLabel(value) {
  return DAY_PART_LABELS[normalizeDayPart(value)] || DAY_PART_LABELS.full;
}

function dayPartSuffix(row) {
  const part = normalizeDayPart(row?.day_part);
  return part === "full" ? "" : ` · ${dayPartLabel(part)}`;
}

function entryDisplayTitleWithDayPart(row) {
  return `${entryDisplayTitle(row)}${dayPartSuffix(row)}`;
}

function setDayPartValue(value) {
  const part = normalizeDayPart(value);
  if (els.formDayPart) els.formDayPart.value = part;
  if (els.formDayPartChips) {
    els.formDayPartChips.querySelectorAll("[data-day-part]").forEach((btn) => {
      const on = (btn.getAttribute("data-day-part") || "full") === part;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
}

function refreshDayPartAvailability() {
  const isRange = Boolean(els.formStart?.value && els.formEnd?.value && els.formStart.value !== els.formEnd.value);
  if (!els.formDayPartChips) return;
  els.formDayPartChips.querySelectorAll("[data-day-part]").forEach((btn) => {
    const part = btn.getAttribute("data-day-part") || "full";
    const disabled = isRange && part !== "full";
    btn.disabled = disabled;
    btn.title = disabled ? "Halbtage sind nur für einzelne Kalendertage möglich" : "";
  });
  if (isRange && normalizeDayPart(els.formDayPart?.value) !== "full") {
    setDayPartValue("full");
  }
}

function readFormPayload() {
  const s = (els.formStart && els.formStart.value) || "";
  const e = (els.formEnd && els.formEnd.value) || "";
  const type = els.formType.value;
  const day_part = s && e && s === e ? normalizeDayPart(els.formDayPart?.value) : "full";
  const suffix =
    type === "sonstiges" && els.formSonstigesSuffix
      ? els.formSonstigesSuffix.value.trim()
      : "";
  return {
    title: buildAutoTitle(type, suffix),
    type,
    start_date: s,
    end_date: e,
    day_part,
    note: els.formNote.value.trim() || null,
  };
}

function isEntryReady() {
  const { title, type, start_date, end_date } = readFormPayload();
  if (!start_date || !end_date || end_date < start_date) return false;
  if (type === "sonstiges") {
    const suffix = els.formSonstigesSuffix ? els.formSonstigesSuffix.value.trim() : "";
    return suffix.length > 0;
  }
  return Boolean(title);
}

function updateSonstigesFieldVisibility() {
  const type = els.formType ? els.formType.value : "urlaub";
  const isSonstiges = type === "sonstiges";
  if (els.formSonstigesWrap) {
    els.formSonstigesWrap.hidden = !isSonstiges;
  }
  if (els.formNamePrefix) {
    els.formNamePrefix.textContent = `${memberKuerzel()}: `;
  }
  if (isSonstiges && els.formSonstigesSuffix) {
    requestAnimationFrame(() => els.formSonstigesSuffix.focus());
  }
}

function updateDoneButton() {
  if (!els.btnDone) return;
  const type = els.formType?.value || "";
  const ready = isEntryReady() && (type !== "urlaub" || isAdminUser);
  els.btnDone.disabled = !ready;
  els.btnDone.textContent = draftEventId ? "Speichern" : "Hinzufügen";
}

function refreshFormState() {
  refreshDayPartAvailability();
  updateDoneButton();
}

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatYmdDe(ymd) {
  if (!ymd || ymd.length < 10) return "—";
  const d = new Date(ymd + "T12:00:00");
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function setDefaultDateRange(startYmd, endYmd) {
  const today = toYmd(new Date());
  const start = startYmd || today;
  const end = endYmd || start;
  if (els.formStart) els.formStart.value = start;
  if (els.formEnd) els.formEnd.value = end;
}

function inclusiveEndToFcEndYmd(ymd) {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return toYmd(d);
}

function entryDisplayTitle(row) {
  const stored = (row.title || "").trim();
  if (stored) return stored;
  const t = row.type === "homeoffice" ? "sonstiges" : row.type;
  return buildAutoTitle(t, "");
}

function rowToFcEvent(row) {
  const t = row.type === "homeoffice" ? "sonstiges" : row.type;
  const col = TYPE_COLORS[t] || TYPE_COLORS.sonstiges;
  const n = row.member_name || currentMemberName || "—";
  const displayTitle = entryDisplayTitleWithDayPart(row);
  return {
    id: `db-${row.id}`,
    title: displayTitle,
    start: row.start_date,
    end: inclusiveEndToFcEndYmd(row.end_date),
    allDay: true,
    backgroundColor: col.bg,
    borderColor: col.bg,
    textColor: col.fg,
    classNames: ["fc-event-entry", `event-type-${t}`],
    extendedProps: {
      source: "db",
      rowId: row.id,
      memberId: row.member_id,
      type: t,
      name: n,
      entryTitle: (row.title || "").trim(),
      dayPart: normalizeDayPart(row.day_part),
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
    display: "auto",
    backgroundColor: TYPE_COLORS.nrw.bg,
    borderColor: "#94a3b8",
    textColor: TYPE_COLORS.nrw.fg,
    classNames: ["fc-event-nrw", "event-type-nrw"],
    extendedProps: { type: "nrw", source: "nrw", notiz: h.label },
  }));
}

function nrwEventContent(arg) {
  if (arg.event.extendedProps?.source !== "nrw") return undefined;
  const span = document.createElement("span");
  span.className = "tk-nrw-tag";
  span.textContent = arg.event.title || "Feiertag";
  return { domNodes: [span] };
}

function entryEventContent(arg) {
  if (arg.event.extendedProps?.source !== "db") return undefined;
  const span = document.createElement("span");
  span.className = "tk-entry-tag";
  span.textContent = arg.event.title || "Eintrag";
  return { domNodes: [span] };
}

function membersFromEventRows(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    if (!row?.member_id || map.has(row.member_id)) return;
    map.set(row.member_id, { id: row.member_id, name: row.member_name || "Unbekannt" });
  });
  return [...map.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
}

function initMemberFilter(members) {
  teamMembers = Array.isArray(members) ? members : [];
  selectedMemberIds = new Set(teamMembers.map((m) => m.id));
  renderMemberFilterList();
}

function renderMemberFilterList() {
  const list = els.memberFilterList;
  if (!list) return;
  if (!teamMembers.length) {
    list.innerHTML = `<p class="tk-member-filter-empty">Keine Personen geladen</p>`;
    return;
  }
  list.innerHTML = teamMembers
    .map((member) => {
      const checked = selectedMemberIds.has(member.id);
      return `<label class="tk-member-filter-item">
        <input type="checkbox" class="tk-member-filter-check" value="${escapeHtml(member.id)}"${checked ? " checked" : ""}>
        <span>${escapeHtml(member.name || "Unbekannt")}</span>
      </label>`;
    })
    .join("");
}

function getVisibleDbRows() {
  if (selectedMemberIds.size === 0) return [];
  return (dbRows || []).filter((row) => selectedMemberIds.has(row.member_id));
}

function setAllMembersSelected(selected) {
  if (selected) selectedMemberIds = new Set(teamMembers.map((m) => m.id));
  else selectedMemberIds = new Set();
  renderMemberFilterList();
  rebuildDbEvents();
}

function calendarEventContent(arg) {
  return nrwEventContent(arg) || entryEventContent(arg);
}

function normalizeSearchText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getEventEntryTitle(event) {
  return normalizeSearchText(event.title || event.extendedProps?.entryTitle || "");
}

function eventMatchesSearch(event, query) {
  const q = normalizeSearchText(query);
  if (!q) return true;
  if (event.id && String(event.id).startsWith("nrw-")) return false;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const title = getEventEntryTitle(event);
  return tokens.every((token) => title.includes(token));
}

function eachDateInInclusiveRange(startYmd, endYmd) {
  const out = [];
  if (!startYmd || !endYmd) return out;
  const cur = new Date(`${startYmd}T12:00:00`);
  const end = new Date(`${endYmd}T12:00:00`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return out;
  while (cur <= end) {
    out.push(toYmd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function formatDateRangeShort(startD, endD) {
  if (!startD) return "—";
  if (!endD || endD === startD) return formatYmdDe(startD);
  return `${formatYmdDe(startD)} – ${formatYmdDe(endD)}`;
}

function compactYmdForCalendar(ymd, addDays = 0) {
  if (!ymd) return "";
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  if (addDays) d.setDate(d.getDate() + addDays);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function getExportRow() {
  if (draftEventId) return dbRows.find((r) => r.id === draftEventId) || null;
  const payload = readFormPayload();
  if (!payload.start_date || !payload.end_date || !payload.title) return null;
  return {
    ...payload,
    id: "draft",
    member_name: currentMemberName,
  };
}

function buildExportData(row) {
  if (!row) return null;
  const title = entryDisplayTitleWithDayPart(row);
  const start = row.start_date;
  const end = row.end_date || start;
  const dayPart = start === end ? normalizeDayPart(row.day_part) : "full";
  const timed = dayPart !== "full";
  const timeRange =
    dayPart === "am"
      ? { startTime: "08:00", endTime: "12:00" }
      : dayPart === "pm"
        ? { startTime: "13:00", endTime: "17:00" }
        : { startTime: "", endTime: "" };
  return {
    title,
    note: row.note || "",
    start,
    end,
    dayPart,
    timed,
    ...timeRange,
    endExclusive: compactYmdForCalendar(end, 1),
    startCompact: compactYmdForCalendar(start),
    fileSlug: `${title || "Kalendereintrag"}_${start || ""}`.replace(/[^\wäöüÄÖÜß-]+/gi, "_").slice(0, 80),
  };
}

function openOutlookExport(data) {
  const startdt = data.timed ? `${data.start}T${data.startTime}:00` : data.start;
  const enddt = data.timed ? `${data.end}T${data.endTime}:00` : data.end;
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: data.title,
    startdt,
    enddt,
    allday: data.timed ? "false" : "true",
    body: data.note || "",
  });
  window.open(`https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`, "_blank", "noopener");
}

function openGoogleExport(data) {
  const dates = data.timed
    ? `${data.start.replace(/-/g, "")}T${data.startTime.replace(":", "")}00/${data.end.replace(/-/g, "")}T${data.endTime.replace(":", "")}00`
    : `${data.startCompact}/${data.endExclusive}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: data.title,
    dates,
    details: data.note || "",
  });
  window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, "_blank", "noopener");
}

function rebuildSearchState() {
  spotlightDates = new Set();
  searchMatches = [];
  if (!calendar || !searchQuery) return;
  calendar.getEvents().forEach((event) => {
    if (event.id && String(event.id).startsWith("nrw-")) return;
    if (!eventMatchesSearch(event, searchQuery)) return;
    const p = event.extendedProps || {};
    searchMatches.push({
      rowId: p.rowId,
      title: event.title || p.entryTitle || "Eintrag",
      startD: p.startD,
      endD: p.endD,
    });
    eachDateInInclusiveRange(p.startD, p.endD).forEach((ymd) => spotlightDates.add(ymd));
  });
  searchMatches.sort((a, b) => {
    if (a.startD !== b.startD) return a.startD.localeCompare(b.startD);
    return (a.title || "").localeCompare(b.title || "", "de");
  });
}

function renderSearchSpotlight() {
  const panel = els.searchSpotlight;
  if (!panel) return;
  const q = searchQuery.trim();
  if (!q) {
    panel.hidden = true;
    panel.innerHTML = "";
    els.search?.setAttribute("aria-expanded", "false");
    return;
  }
  els.search?.setAttribute("aria-expanded", "true");
  panel.hidden = false;
  if (searchMatches.length === 0) {
    panel.innerHTML = `<div class="tk-spotlight-empty">Keine Treffer für „${escapeHtml(q)}“</div>`;
    return;
  }
  const countLabel = searchMatches.length === 1 ? "1 Treffer" : `${searchMatches.length} Treffer`;
  panel.innerHTML = `<div class="tk-spotlight-head">${escapeHtml(countLabel)}</div>${searchMatches
    .map(
      (m, idx) => `<button type="button" class="tk-spotlight-item" data-spotlight-idx="${idx}">
        <span class="tk-spotlight-item__title">${escapeHtml(m.title)}</span>
        <span class="tk-spotlight-item__meta">${escapeHtml(formatDateRangeShort(m.startD, m.endD))}</span>
      </button>`,
    )
    .join("")}`;
}

function refreshSearchVisuals() {
  if (!calendar) return;
  rebuildSearchState();
  renderSearchSpotlight();
  if (els.cal) els.cal.classList.toggle("tk-search-active", Boolean(searchQuery.trim()));
  calendar.render();
}

function applySearch() {
  if (!calendar) return;
  searchQuery = (els.search?.value || "").trim();
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(refreshSearchVisuals, 120);
}

function focusSpotlightMatch(idx) {
  const match = searchMatches[idx];
  if (!match || !calendar) return;
  calendar.gotoDate(match.startD);
  refreshSearchVisuals();
  requestAnimationFrame(() => {
    const cell = els.cal?.querySelector(`.fc-daygrid-day[data-date="${match.startD}"]`);
    cell?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
}

function closeSearchSpotlight() {
  if (!els.searchSpotlight) return;
  els.searchSpotlight.hidden = true;
  els.search?.setAttribute("aria-expanded", "false");
}

function closeModal(ov) {
  ov.classList.remove("is-open");
  ov.setAttribute("aria-hidden", "true");
  draftEventId = null;
  setAutosaveStatus("");
  showUrlaubNotice(false);
  if (els.entryFormMain) els.entryFormMain.hidden = false;
  if (els.btnDone) els.btnDone.hidden = false;
  if (els.formTypeRow) els.formTypeRow.hidden = false;
  updateDoneButton();
}

function setFormTypeValue(type) {
  if (!els.formType) return;
  if (type === "urlaub" && !isAdminUser) {
    showUrlaubNotice(
      true,
      `<i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${URLAUB_BLOCK_MSG}`,
    );
    if (els.btnDone) els.btnDone.hidden = true;
    updateDoneButton();
    return;
  }
  showUrlaubNotice(false);
  if (els.btnDone) els.btnDone.hidden = false;
  const t = type && Object.prototype.hasOwnProperty.call(TYPE_LABELS, type) ? type : "krank";
  els.formType.value = t;
  if (els.formTypeChips) {
    els.formTypeChips.querySelectorAll(".entry-type-card").forEach((btn) => {
      const on = (btn.getAttribute("data-type") || "") === t;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  updateSonstigesFieldVisibility();
  updateDoneButton();
}

function openExportModal() {
  const row = getExportRow();
  const data = buildExportData(row);
  if (!data || !data.start || !data.end || !data.title) {
    toast("Eintrag erst mit Titel und Zeitraum speichern", "err");
    return;
  }
  if (els.exportOvl) {
    els.exportOvl.dataset.exportTitle = data.title;
    els.exportOvl.dataset.exportNote = data.note || "";
    els.exportOvl.dataset.exportStart = data.start;
    els.exportOvl.dataset.exportEnd = data.end;
    els.exportOvl.dataset.exportDayPart = data.dayPart;
    els.exportOvl.classList.add("is-open");
    els.exportOvl.setAttribute("aria-hidden", "false");
  }
}

function closeExportModal() {
  if (!els.exportOvl) return;
  els.exportOvl.classList.remove("is-open");
  els.exportOvl.setAttribute("aria-hidden", "true");
}

function getExportDataFromDialog() {
  if (!els.exportOvl) return null;
  return buildExportData({
    title: els.exportOvl.dataset.exportTitle || "",
    note: els.exportOvl.dataset.exportNote || "",
    start_date: els.exportOvl.dataset.exportStart || "",
    end_date: els.exportOvl.dataset.exportEnd || "",
    day_part: els.exportOvl.dataset.exportDayPart || "full",
  });
}

function handleExportOption(kind) {
  const data = getExportDataFromDialog();
  if (!data) return;
  if (kind === "outlook") openOutlookExport(data);
  else if (kind === "google") openGoogleExport(data);
  else {
    const row = getExportRow();
    if (row) exportSingleEntry(row);
    else toast("Kein Eintrag zum Exportieren", "err");
  }
  closeExportModal();
}

function scheduleAutosave() {
  refreshFormState();
}

async function persistEntry() {
  if (!currentMemberId || saveBusy) return false;
  if (!isEntryReady()) return false;
  const { title, type, start_date, end_date, day_part, note } = readFormPayload();
  if (type === "urlaub" && !isAdminUser) {
    toast(URLAUB_BLOCK_MSG, "err");
    showUrlaubNotice(true, `<i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${URLAUB_BLOCK_MSG}`);
    return false;
  }
  saveBusy = true;
  try {
    let row;
    if (draftEventId) {
      row = await updateEvent(draftEventId, { title, type, start_date, end_date, day_part, note });
    } else {
      row = await insertEvent({
        member_id: currentMemberId,
        title,
        type,
        start_date,
        end_date,
        day_part,
        note,
      });
    }
    const idx = dbRows.findIndex((r) => r.id === row.id);
    if (idx >= 0) dbRows[idx] = row;
    else dbRows.push(row);
    rebuildDbEvents();
    setAutosaveStatus("Gespeichert", "ok");
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || "Speichern fehlgeschlagen", "err");
    setAutosaveStatus("Speichern fehlgeschlagen", "err");
    return false;
  } finally {
    saveBusy = false;
  }
}

function openEntryModal(preset, editRow) {
  if (!currentMemberId) {
    toast("Profil konnte nicht geladen werden", "err");
    return;
  }
  draftEventId = editRow ? editRow.id : null;
  const editType = editRow ? (editRow.type === "homeoffice" ? "sonstiges" : editRow.type) : "krank";
  const readOnly = editRow && isReadOnlyEntry(editRow);
  const isClosure = editRow && isSystemEntry(editRow);

  if (els.modalTitle) {
    els.modalTitle.textContent = readOnly
      ? isClosure
        ? "Betriebsferien / ROOTS-Tag"
        : "Urlaub"
      : editRow
        ? "Eintrag bearbeiten"
        : "Eintrag erstellen";
  }
  if (els.btnDeleteEntry) {
    els.btnDeleteEntry.hidden = !editRow || readOnly;
  }
  if (els.btnExportEntry) {
    els.btnExportEntry.hidden = !editRow;
  }

  if (readOnly) {
    const msg = isClosure
      ? `<i class="fa-solid fa-building" aria-hidden="true"></i> <strong>${formatYmdDe(editRow.start_date)}</strong> – ${escapeHtml(editRow.title || "Betriebsferien")}. Änderungen nur in den Einstellungen der Urlaubsplanung (Admin).`
      : `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Genehmigter Urlaub: <strong>${formatYmdDe(editRow.start_date)} – ${formatYmdDe(editRow.end_date)}</strong>. Änderungen nur über die Urlaubsplanung.`;
    showUrlaubNotice(true, msg);
    if (els.formNote) els.formNote.value = editRow.note || "";
    setDayPartValue(editRow.day_part || "full");
    if (els.btnDone) els.btnDone.hidden = true;
    if (els.btnExportEntry) els.btnExportEntry.hidden = false;
    updateDoneButton();
    setAutosaveStatus("");
    els.modalOvl.classList.add("is-open");
    els.modalOvl.setAttribute("aria-hidden", "false");
    return;
  }

  showUrlaubNotice(false);
  if (els.btnDone) els.btnDone.hidden = false;
  if (els.btnExportEntry) els.btnExportEntry.hidden = !editRow;
  setFormTypeValue(editRow ? editType : "krank");
  if (els.formSonstigesSuffix) {
    els.formSonstigesSuffix.value =
      editRow && editType === "sonstiges" ? parseSonstigesSuffix(editRow.title) : "";
  }
  updateSonstigesFieldVisibility();
  els.formNote.value = editRow ? editRow.note || "" : "";
  setDayPartValue(editRow ? editRow.day_part || "full" : "full");

  const today = toYmd(new Date());
  let startYmd = today;
  let endYmd = today;
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
  setDefaultDateRange(startYmd, endYmd);
  refreshFormState();
  setAutosaveStatus("");
  els.modalOvl.classList.add("is-open");
  els.modalOvl.setAttribute("aria-hidden", "false");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ─── iCal Export ─────────────────────────────────────────── */

/**
 * Format a YYYY-MM-DD date as iCal all-day value: 20260115
 */
function ymdToIcal(ymd) {
  return (ymd || "").replace(/-/g, "");
}

/**
 * Escape iCal text: backslash, semicolon, comma, newline
 */
function icalEscape(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Fold long iCal lines at 75 octets (RFC 5545 §3.1)
 */
function icalFold(line) {
  const MAX = 75;
  if (line.length <= MAX) return line;
  let out = "";
  while (line.length > MAX) {
    out += line.slice(0, MAX) + "\r\n ";
    line = line.slice(MAX);
  }
  return out + line;
}

/**
 * Build a VEVENT block for one calendar row.
 * All-day events use DATE values; end is exclusive (end_date + 1 day).
 */
function rowToVevent(row) {
  const start = ymdToIcal(row.start_date);
  const dayPart = row.start_date === row.end_date ? normalizeDayPart(row.day_part) : "full";
  const isTimed = dayPart !== "full";
  const endDate = new Date(row.end_date + "T00:00:00");
  endDate.setDate(endDate.getDate() + 1);
  const end = endDate.toISOString().slice(0, 10).replace(/-/g, "");
  const uid = `roots-tk-${row.id || start}-${row.member_id || "x"}@roots-consultants.com`;
  const summary = icalEscape(entryDisplayTitleWithDayPart(row));
  const description = icalEscape(row.note || "");
  const category = icalEscape(TYPE_LABELS[row.type] || row.type || "Sonstiges");
  const now = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const startTime = dayPart === "am" ? "080000" : "130000";
  const endTime = dayPart === "am" ? "120000" : "170000";
  const lines = [
    "BEGIN:VEVENT",
    icalFold(`UID:${uid}`),
    icalFold(`DTSTAMP:${now}`),
    isTimed ? icalFold(`DTSTART;TZID=Europe/Berlin:${start}T${startTime}`) : icalFold(`DTSTART;VALUE=DATE:${start}`),
    isTimed ? icalFold(`DTEND;TZID=Europe/Berlin:${start}T${endTime}`) : icalFold(`DTEND;VALUE=DATE:${end}`),
    icalFold(`SUMMARY:${summary}`),
    description ? icalFold(`DESCRIPTION:${description}`) : null,
    icalFold(`CATEGORIES:${category}`),
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ].filter(Boolean);
  return lines.join("\r\n");
}

/**
 * Wrap VEVENTs in a VCALENDAR and trigger browser download.
 */
/* ─── Urlaubskontingent Sidebar ──────────────────────────────── */
async function loadAndRenderQuota() {
  const panel = document.getElementById("tk-quota-panel");
  const list  = document.getElementById("tk-quota-list");
  if (!panel || !list) return;

  // Nur für Manager/Admins anzeigen
  const role = window.RootsUser?._p?.app_role;
  if (!role || role === "reader") return;

  const data = await fetchQuota();
  if (!data || !data.length) return;

  list.innerHTML = data.map((q) => {
    const pct_betrieb = Math.round((q.betrieb / q.initial) * 100);
    const pct_used    = Math.round((q.used    / q.initial) * 100);
    const pct_remain  = Math.round((q.remaining / q.initial) * 100);
    const firstName   = (q.full_name || "").split(" ")[0];
    return `
      <div class="tk-quota-row" title="${escapeHtml(q.full_name)}: ${q.remaining} von ${q.initial} Tagen verbleibend">
        <div class="tk-quota-name">${escapeHtml(firstName)}</div>
        <div class="tk-quota-bar-wrap">
          <div class="tk-quota-bar tk-quota-bar--betrieb" style="width:${pct_betrieb + pct_used}%"></div>
          <div class="tk-quota-bar tk-quota-bar--used"    style="width:${pct_used}%"></div>
        </div>
        <div class="tk-quota-meta">
          <span>${q.used}d Urlaub · ${q.betrieb}d Betrieb</span>
          <span class="tk-quota-remaining">${q.remaining}/${q.initial}</span>
        </div>
      </div>`;
  }).join("");

  panel.hidden = false;
}

async function fetchQuota() {
  try {
    const data = await apiJson("GET", "?list=quota", null);
    return data || [];
  } catch { return []; }
}

function downloadIcs(vevents, filename) {
  const cal = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ROOTS Brand Strategy Consultants//Team-Kalender//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:ROOTS Team-Kalender",
    "X-WR-TIMEZONE:Europe/Berlin",
    ...vevents,
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([cal], { type: "text/calendar;charset=utf-8" });
  // Use bridge helper so downloads work inside the macOS iframe app too
  const downloader = window.RootsUserBridge?.downloadBlob;
  if (downloader) {
    downloader(blob, filename);
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }
}

/**
 * Export a single entry as .ics
 */
function exportSingleEntry(row) {
  if (!row) return;
  const safeName = (row.title || "eintrag").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  downloadIcs([rowToVevent(row)], `ROOTS_${safeName}.ics`);
  toast("Kalendereintrag heruntergeladen (.ics)", "ok");
}

/**
 * Export all currently visible entries as one .ics feed.
 * Respects the active member filter (selectedMemberIds).
 */
function exportAllVisible() {
  const rows = dbRows.filter((r) => {
    if (!selectedMemberIds.size) return true;
    return selectedMemberIds.has(r.member_id);
  });
  if (!rows.length) {
    toast("Keine Einträge zum Exportieren", "err");
    return;
  }
  const vevents = rows.map(rowToVevent);
  downloadIcs(vevents, "ROOTS_Teamkalender.ics");
  toast(`${rows.length} Einträge exportiert (.ics)`, "ok");
}

function isRootsProfileReady() {
  const ru = window.RootsUser;
  return Boolean(ru?._uid && ru?._p && ru._p.id === ru._uid);
}

function waitForRootsUser(maxMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (isRootsProfileReady()) resolve(window.RootsUser);
      else if (Date.now() - t0 > maxMs) resolve(null);
      else setTimeout(tick, 120);
    };
    tick();
  });
}

async function resolveCurrentMember() {
  const ru = await waitForRootsUser();
  if (!ru?._uid || !ru._p || ru._p.id !== ru._uid) {
    currentMemberId = null;
    currentMemberName = "";
    throw new Error("Nicht angemeldet");
  }
  const name = (ru._p.full_name || ru._p.email || "Nutzer").trim();
  const m = await ensureMemberForUser(ru._uid, name);
  currentMemberId = m.id;
  currentMemberName = name;
  currentMemberKuerzel = m.kuerzel || ru._p.kuerzel || deriveKuerzel(name);
  refreshAdminState();
  updateSonstigesFieldVisibility();
}

function rebuildDbEvents() {
  if (!calendar) return;
  const events = getVisibleDbRows().map(rowToFcEvent);
  calendar.getEvents().filter((e) => e.id && String(e.id).startsWith("db-")).forEach((e) => e.remove());
  events.forEach((e) => calendar.addEvent(e));
  refreshSearchVisuals();
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
  initTeamKalenderApi({
    getAccessToken: async () => {
      const sb = window.RootsUser?._sb;
      if (!sb) return null;
      const {
        data: { session },
      } = await sb.auth.getSession();
      return session?.access_token || null;
    },
  });

  els.cal = document.getElementById("calendar");
  els.toast = document.getElementById("toast-container");
  els.modalOvl = document.getElementById("modal-create");
  els.formType = document.getElementById("f-type");
  els.formTypeChips = document.getElementById("f-type-chips");
  els.formStart = document.getElementById("f-start");
  els.formEnd = document.getElementById("f-end");
  els.formDayPart = document.getElementById("f-day-part");
  els.formDayPartChips = document.getElementById("f-day-part-chips");
  els.formSonstigesWrap = document.getElementById("f-sonstiges-wrap");
  els.formSonstigesSuffix = document.getElementById("f-sonstiges-suffix");
  els.formNamePrefix = document.getElementById("f-name-prefix");
  els.formNote = document.getElementById("f-note");
  els.autosaveStatus = document.getElementById("f-autosave-status");
  els.modalTitle = document.getElementById("m-title");
  els.btnDeleteEntry = document.getElementById("btn-delete-entry");
  els.btnExportEntry = document.getElementById("btn-export-entry");
  els.btnDone = document.getElementById("m-done");
  els.exportOvl = document.getElementById("modal-export");
  els.exportClose = document.getElementById("export-close");
  els.exportBox = document.getElementById("export-box");
  els.search = document.getElementById("header-search");
  els.searchSpotlight = document.getElementById("search-spotlight");
  els.memberFilterList = document.getElementById("member-filter-list");
  els.memberSelectAll = document.getElementById("member-select-all");
  els.memberSelectNone = document.getElementById("member-select-none");
  els.btnCreate = document.getElementById("btn-new-entry");
  els.btnViewMonth = document.getElementById("view-month");
  els.btnViewYear = document.getElementById("view-year");
  els.urlaubNotice = document.getElementById("f-urlaub-notice");
  els.urlaubNoticeText = document.getElementById("f-urlaub-notice-text");
  els.entryFormMain = document.getElementById("f-entry-form-main");
  els.formTypeRow = document.querySelector(".field-group-type");
  els.btnOpenUrlaubsplanung = document.getElementById("btn-open-urlaubsplanung");
if (els.formType) setFormTypeValue(els.formType.value || "krank");

  if (els.btnOpenUrlaubsplanung) {
    els.btnOpenUrlaubsplanung.addEventListener("click", openUrlaubsplanung);
  }

  // Global: export all visible entries as .ics
if (els.formTypeChips) {
    els.formTypeChips.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest(".entry-type-card[data-type]");
      if (!btn) return;
      if (btn.getAttribute("data-type") === "urlaub" && !isAdminUser) {
        setFormTypeValue("urlaub");
        return;
      }
      setFormTypeValue(btn.getAttribute("data-type") || "krank");
      scheduleAutosave();
    });
  }
  if (els.formSonstigesSuffix) {
    els.formSonstigesSuffix.addEventListener("input", refreshFormState);
  }
  if (els.formDayPartChips) {
    els.formDayPartChips.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest("[data-day-part]");
      if (!btn || btn.disabled) return;
      setDayPartValue(btn.getAttribute("data-day-part") || "full");
      refreshFormState();
    });
  }
  if (els.formNote) els.formNote.addEventListener("input", refreshFormState);
  if (els.formStart) {
    els.formStart.addEventListener("change", () => {
      if (els.formEnd.value && els.formEnd.value < els.formStart.value) {
        els.formEnd.value = els.formStart.value;
      }
      refreshFormState();
    });
  }
  if (els.formEnd) {
    els.formEnd.addEventListener("change", refreshFormState);
  }
  if (els.btnDone) {
    els.btnDone.addEventListener("click", async () => {
      if (!isEntryReady() || (els.formType?.value === "urlaub" && !isAdminUser)) return;
      const ok = await persistEntry();
      if (ok) closeModal(els.modalOvl);
    });
  }
  if (els.btnExportEntry) {
    els.btnExportEntry.addEventListener("click", (e) => {
      e.stopPropagation();
      openExportModal();
    });
  }
  if (els.exportClose) els.exportClose.addEventListener("click", closeExportModal);
  if (els.exportOvl) {
    els.exportOvl.addEventListener("click", (e) => {
      if (e.target === els.exportOvl) closeExportModal();
      const opt = e.target?.closest?.("[data-export-kind]");
      if (opt) handleExportOption(opt.getAttribute("data-export-kind"));
    });
  }

  setDefaultDateRange(toYmd(new Date()), toYmd(new Date()));
  refreshFormState();

  if (!TEAM_KALENDER_API_URL || TEAM_KALENDER_API_URL.includes("<")) {
    toast("config.js: TEAM_KALENDER_API_URL prüfen", "err");
    return;
  }

  try {
    await resolveCurrentMember();
    const [ev, nrw, members] = await Promise.all([
      fetchAllEvents(),
      fetchNrwHolidays(),
      fetchTeamMembers().catch(() => null),
    ]);
    dbRows = ev || [];
    nrwHolidayRows = nrw || [];
    nrwDateSet = new Set(nrwHolidayRows.map((h) => h.holiday_date));
    initMemberFilter(Array.isArray(members) && members.length ? members : membersFromEventRows(dbRows));
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
    dayMaxEvents: 6,
    weekNumbers: false,
    showNonCurrentDates: false,
    fixedWeekCount: true,
    moreLinkText(n) {
      return n === 1 ? "+1 weitere" : `+${n} weitere`;
    },
    views: {
      dayGridMonth: { showNonCurrentDates: false, fixedWeekCount: true },
      multiMonthYear: {
        multiMonthMaxColumns: 3,
        multiMonthMinWidth: 200,
        dayMaxEvents: 3,
        showNonCurrentDates: false,
        fixedWeekCount: true,
      },
    },
    buttonText: { today: "Heute" },
    eventContent(arg) {
      return calendarEventContent(arg);
    },
    eventClassNames(arg) {
      if (!searchQuery.trim()) return [];
      if (arg.event.extendedProps?.source !== "db") return ["tk-search-dim"];
      return eventMatchesSearch(arg.event, searchQuery) ? [] : ["tk-search-dim"];
    },
    dayCellClassNames(arg) {
      if (!searchQuery.trim()) return [];
      const ymd = toYmd(arg.date);
      return spotlightDates.has(ymd) ? ["tk-spotlight-day"] : ["tk-search-dim-day"];
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
      rebuildSearchState();
      syncViewButtons();
    },
  });

  syncViewButtons = function () {
    if (!calendar) return;
    const t = calendar.view.type;
    [els.btnViewMonth, els.btnViewYear].forEach((b) => {
      if (!b) return;
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
    let activeBtn = els.btnViewMonth;
    if (t === "multiMonthYear") activeBtn = els.btnViewYear;
    if (activeBtn) {
      activeBtn.classList.add("active");
      activeBtn.setAttribute("aria-pressed", "true");
    }
    const titleEl = document.getElementById("dash-cal-title");
    if (titleEl && calendar.view?.title) titleEl.textContent = calendar.view.title;
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
  els.btnViewYear.addEventListener("click", () => calendar.changeView("multiMonthYear"));

  els.btnCreate.addEventListener("click", () => {
    openEntryModal(null, null);
  });

  document.getElementById("m-cancel").addEventListener("click", () => closeModal(els.modalOvl));
  document.getElementById("m-close").addEventListener("click", () => closeModal(els.modalOvl));
  if (els.modalOvl) {
    els.modalOvl.addEventListener("click", (e) => {
      if (e.target === els.modalOvl) closeModal(els.modalOvl);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (els.exportOvl?.classList.contains("is-open")) {
        e.preventDefault();
        closeExportModal();
        return;
      }
      if (!els.modalOvl.classList.contains("is-open")) return;
      e.preventDefault();
      closeModal(els.modalOvl);
    });
  }

  if (els.btnDeleteEntry) {
    els.btnDeleteEntry.addEventListener("click", async () => {
      if (!draftEventId) return;
      const row = dbRows.find((r) => r.id === draftEventId);
      if (isReadOnlyEntry(row)) {
        toast("Dieser Eintrag kann hier nicht bearbeitet werden", "err");
        openEntryModal(null, row);
        return;
      }
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
  els.memberFilterList?.addEventListener("change", (e) => {
    const cb = e.target.closest(".tk-member-filter-check");
    if (!cb) return;
    if (cb.checked) selectedMemberIds.add(cb.value);
    else selectedMemberIds.delete(cb.value);
    rebuildDbEvents();
  });
  els.memberSelectAll?.addEventListener("click", () => setAllMembersSelected(true));
  els.memberSelectNone?.addEventListener("click", () => setAllMembersSelected(false));
  els.search.addEventListener("focus", () => {
    if (searchQuery.trim()) renderSearchSpotlight();
  });
  els.searchSpotlight?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-spotlight-idx]");
    if (!btn) return;
    focusSpotlightMatch(parseInt(btn.dataset.spotlightIdx, 10));
  });
  document.addEventListener("click", (e) => {
    if (!els.search?.contains(e.target) && !els.searchSpotlight?.contains(e.target)) {
      closeSearchSpotlight();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.activeElement === els.search) {
      els.search.value = "";
      searchQuery = "";
      refreshSearchVisuals();
      closeSearchSpotlight();
      els.search.blur();
    }
  });

  document.addEventListener("roots-profile-ready", () => {
    refreshAdminState();
    resolveCurrentMember().catch((e) => {
      console.error(e);
      toast(e.message || "Profil konnte nicht geladen werden", "err");
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
