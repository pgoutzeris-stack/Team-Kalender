/**
 * NRW Feiertage 2025–2030 (statisch).
 * Ostersonntage: nach astronomischer Berechnung / amtlichen Listen.
 * Bewegliche Feiertage: relativ zu Ostern.
 */
const EASTER_SUNDAY = {
  2025: { m: 4, d: 20 },
  2026: { m: 4, d: 5 },
  2027: { m: 3, d: 28 },
  2028: { m: 4, d: 16 },
  2029: { m: 4, d: 1 },
  2030: { m: 4, d: 21 },
};

function pad2(n) {
  return String(n).padStart(2, "0");
}
function toYmd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function ymdToDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDaysYmd(ymd, days) {
  const x = ymdToDate(ymd);
  x.setDate(x.getDate() + days);
  return toYmd(x.getFullYear(), x.getMonth() + 1, x.getDate());
}

const LABELS = {
  neujahr: "Neujahr",
  karfreitag: "Karfreitag",
  ostmontag: "Ostermontag",
  tagderarbeit: "Tag der Arbeit",
  himmelfahrt: "Christi Himmelfahrt",
  pfingstmontag: "Pfingstmontag",
  fronleichnam: "Fronleichnam",
  einheit: "Tag der Deutschen Einheit",
  allerheiligen: "Allerheiligen",
  weih1: "1. Weihnachtsfeiertag",
  weih2: "2. Weihnachtsfeiertag",
};

/**
 * @returns {{ id: string, title: string, start: string, allDay: boolean, display: string, classNames: string[], extendedProps: object }[]}
 */
export function getNrwFeiertageAsCalendarEvents() {
  const out = [];
  for (let y = 2025; y <= 2030; y++) {
    const e = EASTER_SUNDAY[y];
    if (!e) continue;
    const easterYmd = toYmd(y, e.m, e.d);
    const push = (ymd, key) => {
      out.push({
        id: `nrw-${ymd}-${key}`,
        title: `NRW · ${LABELS[key] || key}`,
        start: ymd,
        allDay: true,
        classNames: ["fc-event-nrw", "event-type-nrw"],
        extendedProps: {
          type: "nrw",
          source: "nrw",
          name: "NRW",
          notiz: LABELS[key] || key,
        },
      });
    };
    push(toYmd(y, 1, 1), "neujahr");
    push(addDaysYmd(easterYmd, -2), "karfreitag");
    push(addDaysYmd(easterYmd, 1), "ostmontag");
    push(toYmd(y, 5, 1), "tagderarbeit");
    push(addDaysYmd(easterYmd, 39), "himmelfahrt");
    push(addDaysYmd(easterYmd, 50), "pfingstmontag");
    push(addDaysYmd(easterYmd, 60), "fronleichnam");
    push(toYmd(y, 10, 3), "einheit");
    push(toYmd(y, 11, 1), "allerheiligen");
    push(toYmd(y, 12, 25), "weih1");
    push(toYmd(y, 12, 26), "weih2");
  }
  return out;
}
