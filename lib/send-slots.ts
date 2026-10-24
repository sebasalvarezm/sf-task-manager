/**
 * When to send. Half the batch goes out between 6:45 and 8:00 in the
 * recipient's morning, half between 5:00 and 7:00 in their evening, spaced
 * five to six minutes apart in a shuffled order so the times look human. A
 * window that is full spills to the next day. Saturdays yes, Sundays never
 * (the outreach week starts on Sunday).
 */

const MORNING = { start: 6 * 60 + 45, end: 8 * 60 };
const EVENING = { start: 17 * 60, end: 19 * 60 };
const SPACING_MIN = 5;
const SPACING_MAX = 6;

// US states and Canadian provinces to IANA zones. Country-level fallbacks below.
const US_STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles",
  CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Denver", IL: "America/Chicago", IN: "America/New_York",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/New_York", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago",
  WY: "America/Denver",
};
const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const CA_PROV_TZ: Record<string, string> = {
  BC: "America/Vancouver", AB: "America/Edmonton", SK: "America/Regina", MB: "America/Winnipeg", ON: "America/Toronto",
  QC: "America/Toronto", NB: "America/Halifax", NS: "America/Halifax", PE: "America/Halifax", NL: "America/St_Johns", YT: "America/Whitehorse",
  NT: "America/Yellowknife", NU: "America/Iqaluit",
};
const CA_PROV_NAMES: Record<string, string> = {
  "british columbia": "BC", alberta: "AB", saskatchewan: "SK", manitoba: "MB", ontario: "ON", quebec: "QC", québec: "QC",
  "new brunswick": "NB", "nova scotia": "NS", "prince edward island": "PE", "newfoundland and labrador": "NL", newfoundland: "NL",
  yukon: "YT", "northwest territories": "NT", nunavut: "NU",
};
const AU_STATE_TZ: Record<string, string> = {
  NSW: "Australia/Sydney", VIC: "Australia/Melbourne", QLD: "Australia/Brisbane", SA: "Australia/Adelaide", WA: "Australia/Perth",
  TAS: "Australia/Hobart", ACT: "Australia/Sydney", NT: "Australia/Darwin",
};
const AU_STATE_NAMES: Record<string, string> = {
  "new south wales": "NSW", victoria: "VIC", queensland: "QLD", "south australia": "SA", "western australia": "WA", tasmania: "TAS",
  "australian capital territory": "ACT", "northern territory": "NT",
};
const COUNTRY_TZ: Record<string, string> = {
  "united states": "America/New_York", usa: "America/New_York", us: "America/New_York",
  canada: "America/Toronto",
  "united kingdom": "Europe/London", uk: "Europe/London", england: "Europe/London", scotland: "Europe/London",
  ireland: "Europe/Dublin",
  netherlands: "Europe/Amsterdam", belgium: "Europe/Brussels", germany: "Europe/Berlin", france: "Europe/Paris",
  australia: "Australia/Sydney",
  "new zealand": "Pacific/Auckland",
};

/** Best IANA zone for a Salesforce country/state pair. Falls back to Eastern. */
export function recipientTimeZone(country: string | null | undefined, state: string | null | undefined): string {
  const c = (country ?? "").trim().toLowerCase();
  const s = (state ?? "").trim();
  const sUpper = s.toUpperCase();
  const sLower = s.toLowerCase();
  if (/^(united states|usa|us)$/.test(c) || (!c && US_STATE_TZ[sUpper])) {
    const code = US_STATE_TZ[sUpper] ? sUpper : US_STATE_NAMES[sLower];
    if (code && US_STATE_TZ[code]) return US_STATE_TZ[code];
    return "America/New_York";
  }
  if (c === "canada" || (!c && CA_PROV_TZ[sUpper])) {
    const code = CA_PROV_TZ[sUpper] ? sUpper : CA_PROV_NAMES[sLower];
    if (code && CA_PROV_TZ[code]) return CA_PROV_TZ[code];
    return "America/Toronto";
  }
  if (c === "australia") {
    const code = AU_STATE_TZ[sUpper] ? sUpper : AU_STATE_NAMES[sLower];
    if (code && AU_STATE_TZ[code]) return AU_STATE_TZ[code];
    return "Australia/Sydney";
  }
  return COUNTRY_TZ[c] ?? "America/New_York";
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

function isSundayInMontreal(at: Date): boolean {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", weekday: "short" }).format(at) === "Sun";
}

function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday };
}

/** The instant for a wall-clock time in a zone (two-pass offset fix handles DST). */
function zonedTime(year: number, month: number, day: number, minutesOfDay: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  const offsetAt = (t: number) => {
    const p = localParts(new Date(t), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return asUtc - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

function addDays(year: number, month: number, day: number, n: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export type SlotRequest = { id: string; timeZone: string };
export type SlotAssignment = { id: string; at: Date; window: "morning" | "evening"; timeZone: string };

/**
 * Assign a send time to each request. Deterministic given `now` and `random`,
 * so tests can pin it; production passes Math.random.
 */
export function planSendSlots(requests: SlotRequest[], now: Date = new Date(), random: () => number = Math.random): SlotAssignment[] {
  // Shuffle so the order within a window is not alphabetical or by import order.
  const order = requests.map((r, i) => ({ r, key: random() + i * 1e-9 })).sort((a, b) => a.key - b.key).map((x) => x.r);
  // Per zone, per day, per window: the next free minute.
  const cursors = new Map<string, number>();
  const out: SlotAssignment[] = [];
  let flip = random() < 0.5;
  for (const req of order) {
    const window = flip ? "morning" : "evening";
    flip = !flip;
    out.push(place(req, window, now, cursors, random));
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function place(req: SlotRequest, preferred: "morning" | "evening", now: Date, cursors: Map<string, number>, random: () => number): SlotAssignment {
  const tz = req.timeZone;
  const local = localParts(now, tz);
  let day = { year: local.year, month: local.month, day: local.day };
  let window = preferred;
  // Up to ten days out is plenty; after that something is wrong and we just stack.
  for (let i = 0; i < 20; i++) {
    // Saturdays count (founders answer on a Saturday); Sundays do not, because
    // the outreach week starts on Sunday and a Sunday send would land in next
    // week's numbers. Checked in the recipient's day and in Seb's (Montreal).
    if (new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() === 0) {
      day = addDays(day.year, day.month, day.day, 1);
      continue;
    }
    const range = window === "morning" ? MORNING : EVENING;
    const key = `${tz}|${day.year}-${day.month}-${day.day}|${window}`;
    const nowMinutes = i === 0 || sameDay(day, local) ? local.hour * 60 + local.minute : -1;
    // Earliest minute: window start, or a little after "now" if we are already inside the window.
    const earliest = Math.max(range.start, sameDay(day, local) ? nowMinutes + 15 : range.start);
    const cursor = cursors.get(key);
    const candidate = cursor === undefined ? earliest + Math.floor(random() * 4) : cursor + SPACING_MIN + Math.floor(random() * (SPACING_MAX - SPACING_MIN + 1));
    if (candidate <= range.end) {
      const at = zonedTime(day.year, day.month, day.day, candidate, tz);
      if (isSundayInMontreal(at)) {
        // e.g. Saturday evening in Hawaii is already Sunday in Montreal.
        day = addDays(day.year, day.month, day.day, 1);
        continue;
      }
      cursors.set(key, candidate);
      return { id: req.id, at, window, timeZone: tz };
    }
    if (earliest > range.end) {
      // The window has already gone by today: same window, next day, so the
      // morning/evening split of the batch survives.
      day = addDays(day.year, day.month, day.day, 1);
      continue;
    }
    // The window is full: the other window today, then on to the next day.
    if (window === preferred) {
      window = preferred === "morning" ? "evening" : "morning";
    } else {
      window = preferred;
      day = addDays(day.year, day.month, day.day, 1);
    }
  }
  return { id: req.id, at: zonedTime(day.year, day.month, day.day, MORNING.start, tz), window, timeZone: tz };
}

function sameDay(d: { year: number; month: number; day: number }, l: LocalParts): boolean {
  return d.year === l.year && d.month === l.month && d.day === l.day;
}

export function formatSlot(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
}
