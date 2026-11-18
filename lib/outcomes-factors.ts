// Factor tests for What gets replies (Nov 2026).
//
// A factor is one yes/no question about a send ("Name <> Name subject?",
// "sent on a Friday?"). Each test compares the sends where the answer is yes
// with the ones where it is no, AFTER accounting for the things we already
// know move replies (country, company age, size, quality, sender, first
// contact or not, kind of send). So a factor cannot look good just because it
// happened to go to more Canadian companies.
//
// Honesty rules:
//   • Only sends old enough to have had their full 45 days to get a reply.
//   • "Act on it" needs a strong result (p < 0.01, because many factors are
//     tested and roughly 1 in 20 looks real by luck at p < 0.05) AND the same
//     direction in the older half and the newer half of the sends.
//   • Too little data says so instead of guessing.
//
// Pure arithmetic: no Supabase, no Salesforce, no AI. Factors are plain data
// (FactorSpec), so a new one can be proposed and tested without new code.

import { subjectStyle, wilson, type SendRow } from "./outcomes-analysis";

export type FactorRow = SendRow & {
  account_id?: string | null;
  account_name?: string | null;
  contact_email?: string | null;
  contact_title?: string | null;
};

// ── The vocabulary a factor can use ─────────────────────────────────────────

export const TEXT_FIELDS = [
  "subject", // the E1 subject line
  "subject_style", // specific (restaurant + date) | generic ("Lunch: Valstone")
  "title", // contact's Salesforce title
  "email_kind", // company | generic (info@, sales@) | personal (gmail, outlook...)
  "country", // as in Salesforce
  "country_group", // US | Canada | UK | Europe | Other | Unknown
  "industry",
  "sequence",
  "sender",
  "quality", // clean | potential | flagged
  "kind", // E1 | RCE1 | D-E1
] as const;
export const NUMBER_FIELDS = [
  "employees",
  "founded",
  "weekday", // 0 Sunday .. 6 Saturday (Eastern)
  "hour", // 0..23 Eastern
  "month", // 1..12
  "day", // day of month
  "lead_days", // days from the send to the date named in the subject (lunch date)
  "prior_sends", // earlier sequence starts to this account
  "gap_days", // days since the previous send to this account (re-contacts only)
  "subject_length",
] as const;
export const FLAG_FIELDS = [
  "same_person", // re-contact went to the same email as the previous send
  "company_in_subject", // the company's name appears in the subject
  "first_name_in_subject", // the contact's first name (from their email) appears in the subject
] as const;

export type TextField = (typeof TEXT_FIELDS)[number];
export type NumberField = (typeof NUMBER_FIELDS)[number];
export type FlagField = (typeof FLAG_FIELDS)[number];
export type Field = TextField | NumberField | FlagField;

/**
 * One condition. matches: case-insensitive regex on a text field. in: exact
 * (case-insensitive) list. between: [min, max] inclusive, null = open. is:
 * true/false for a flag field. known: the field has a value. not: flips it.
 */
export type Cond =
  | { field: TextField; op: "matches"; value: string; not?: boolean }
  | { field: TextField; op: "in"; value: string[]; not?: boolean }
  | { field: NumberField; op: "between"; value: [number | null, number | null]; not?: boolean }
  | { field: FlagField; op: "is"; value: boolean; not?: boolean }
  | { field: Field; op: "known"; not?: boolean };

export const CONTROL_KEYS = ["country", "founded", "employees", "quality", "sender", "prior", "kind"] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];

export type FactorSpec = {
  id: string;
  label: string;
  /** The question in plain words, shown on the card. */
  question: string;
  /** Group A: every condition holds. */
  test: Cond[];
  /** Group B: every condition holds. Default: everything else in scope. */
  compare?: Cond[];
  /** Which sends are looked at at all (default: every tracked send). */
  scope?: Cond[];
  aLabel: string;
  bLabel: string;
  /** Controls to leave out because the factor is itself about them (testing country, say). */
  dropControls?: ControlKey[];
  /** Why it is worth testing (proposals). */
  why?: string;
};

// ── Deriving the fields ─────────────────────────────────────────────────────

const EUROPE = /^(ireland|netherlands|the netherlands|germany|france|spain|italy|belgium|sweden|norway|denmark|finland|switzerland|austria|poland|portugal|czech|czechia|czech republic|luxembourg|iceland|estonia|latvia|lithuania|slovenia|slovakia|hungary|greece|croatia|romania|bulgaria)$/i;

export function countryGroup(c: string | null | undefined): string {
  const s = (c ?? "").trim().toLowerCase();
  if (!s) return "Unknown";
  if (/^(united states|usa|us|u\.s\.a?\.?)$/.test(s)) return "US";
  if (/^(canada|ca)$/.test(s)) return "Canada";
  if (/^(united kingdom|uk|great britain|england|scotland|wales|northern ireland|gb)$/.test(s)) return "UK";
  if (EUROPE.test(s)) return "Europe";
  return "Other";
}

const GENERIC_LOCAL = /^(info|sales|contact|admin|office|hello|support|enquiries|inquiries|mail|team|marketing|service|accounts|general)$/i;
const PERSONAL_DOMAIN = /^(gmail|googlemail|yahoo|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|comcast|shaw|rogers|telus|bell|sympatico|videotron)\./i;

export function emailKind(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return null;
  if (PERSONAL_DOMAIN.test(e.slice(at + 1))) return "personal";
  if (GENERIC_LOCAL.test(e.slice(0, at))) return "generic";
  return "company";
}

/** First name from "john.smith@" or "john_smith@"; null when the address does not look like a name. */
export function firstNameFromEmail(email: string | null | undefined): string | null {
  const local = (email ?? "").split("@")[0]?.toLowerCase() ?? "";
  const first = local.split(/[._-]/)[0] ?? "";
  if (!/^[a-z]{3,}$/.test(first) || GENERIC_LOCAL.test(first)) return null;
  return first;
}

const MONTH_INDEX: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Days from the send to the date named in the subject ("Prince & Pauper Dec 2: Valstone"), or null. */
export function leadDays(subject: string | null | undefined, sentOn: string): number | null {
  const m = (subject ?? "").match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i) ?? (subject ?? "").match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  if (!m) return null;
  const monthWord = /\d/.test(m[1]) ? m[2] : m[1];
  const day = Number(/\d/.test(m[1]) ? m[1] : m[2]);
  const month = MONTH_INDEX[monthWord.slice(0, 3).toLowerCase()];
  if (month == null || day < 1 || day > 31) return null;
  const sent = Date.parse(`${sentOn}T00:00:00Z`);
  const year = new Date(sent).getUTCFullYear();
  // The lunch date is the next one on or after (send date minus a month).
  for (const y of [year - 1, year, year + 1]) {
    const t = Date.UTC(y, month, day);
    const diff = Math.round((t - sent) / 86_400_000);
    if (diff >= -30 && diff <= 335) return diff;
  }
  return null;
}

type Derived = Record<Field, string | number | boolean | null>;

/** Previous send to the same account, for gap and same-person fields. Uses every send, tracked or not. */
function previousSends(rows: FactorRow[]): Map<FactorRow, FactorRow | null> {
  const byAccount = new Map<string, FactorRow[]>();
  for (const r of rows) {
    if (!r.account_id) continue;
    const list = byAccount.get(r.account_id) ?? [];
    list.push(r);
    byAccount.set(r.account_id, list);
  }
  const prev = new Map<FactorRow, FactorRow | null>();
  for (const list of byAccount.values()) {
    list.sort((a, b) => (a.sent_on < b.sent_on ? -1 : a.sent_on > b.sent_on ? 1 : 0));
    list.forEach((r, i) => prev.set(r, i > 0 ? list[i - 1] : null));
  }
  return prev;
}

function derive(r: FactorRow, prev: FactorRow | null | undefined): Derived {
  const subject = r.subject ?? null;
  const sent = Date.parse(`${r.sent_on}T00:00:00Z`);
  const d = new Date(sent);
  const companyWord = r.account_name?.split(/[\s,.]+/).find((w) => w.length >= 4 && !/^(the|inc|corp|group|systems|software|solutions|technologies|technology|services)$/i.test(w)) ?? null;
  const first = firstNameFromEmail(r.contact_email);
  const s = (subject ?? "").toLowerCase();
  return {
    subject,
    subject_style: subjectStyle(subject),
    title: r.contact_title ?? null,
    email_kind: emailKind(r.contact_email),
    country: r.country ?? null,
    country_group: countryGroup(r.country),
    industry: r.industry ?? null,
    sequence: r.sequence_name ?? null,
    sender: r.sender ?? null,
    quality: r.quality ?? null,
    kind: r.subject_type,
    employees: r.employees,
    founded: r.founded,
    weekday: r.weekday,
    hour: r.hour_et,
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    lead_days: leadDays(subject, r.sent_on),
    prior_sends: r.prior_sends,
    gap_days: prev ? Math.round((sent - Date.parse(`${prev.sent_on}T00:00:00Z`)) / 86_400_000) : null,
    subject_length: subject ? subject.trim().length : null,
    same_person: prev && prev.contact_email && r.contact_email ? prev.contact_email.toLowerCase() === r.contact_email.toLowerCase() : null,
    company_in_subject: subject && companyWord ? s.includes(companyWord.toLowerCase()) : null,
    first_name_in_subject: subject && first ? new RegExp(`\\b${first}\\b`).test(s) : null,
  };
}

function holds(c: Cond, v: Derived): boolean {
  const x = v[c.field];
  let ok: boolean;
  switch (c.op) {
    case "known":
      ok = x !== null && x !== undefined && x !== "";
      break;
    case "matches":
      ok = typeof x === "string" && new RegExp(c.value, "i").test(x);
      break;
    case "in":
      ok = typeof x === "string" && c.value.some((y) => y.toLowerCase() === x.toLowerCase());
      break;
    case "between": {
      const [lo, hi] = c.value;
      ok = typeof x === "number" && (lo == null || x >= lo) && (hi == null || x <= hi);
      break;
    }
    case "is":
      ok = x === c.value;
      break;
  }
  // "not" only flips a condition the row can be judged on: an unknown value stays out.
  if (c.not) return c.op === "known" ? !ok : x !== null && x !== undefined && !ok;
  return ok;
}

const all = (conds: Cond[] | undefined, v: Derived) => (conds ?? []).every((c) => holds(c, v));

// ── Checking a proposed factor ──────────────────────────────────────────────

const ID = /^[a-z0-9][a-z0-9_-]{1,40}$/;

/** A proposed factor, checked field by field. Returns the clean spec or the reason it was refused. Pure. */
export function validateSpec(raw: unknown): { spec: FactorSpec } | { error: string } {
  const r = raw as Partial<FactorSpec> | null;
  if (!r || typeof r !== "object") return { error: "No factor given." };
  if (!r.id || !ID.test(r.id)) return { error: "id: lowercase letters, digits, - or _, 2 to 41 characters." };
  for (const k of ["label", "question", "aLabel", "bLabel"] as const) {
    if (typeof r[k] !== "string" || !r[k]!.trim() || r[k]!.length > 200) return { error: `${k}: a short sentence is needed.` };
  }
  const checkConds = (list: unknown, name: string, required: boolean): Cond[] | string => {
    if (list === undefined && !required) return [];
    if (!Array.isArray(list) || (required && list.length === 0) || list.length > 6) return `${name}: 1 to 6 conditions.`;
    const out: Cond[] = [];
    for (const c of list as Array<Record<string, unknown>>) {
      const field = c?.field as Field;
      const op = c?.op as string;
      const not = c?.not === true ? { not: true } : {};
      const isText = (TEXT_FIELDS as readonly string[]).includes(field);
      const isNum = (NUMBER_FIELDS as readonly string[]).includes(field);
      const isFlag = (FLAG_FIELDS as readonly string[]).includes(field);
      if (!isText && !isNum && !isFlag) return `${name}: unknown field "${String(field)}".`;
      if (op === "known") out.push({ field, op: "known", ...not });
      else if (op === "matches" && isText && typeof c.value === "string" && c.value.length > 0 && c.value.length <= 120) {
        try {
          new RegExp(c.value, "i");
        } catch {
          return `${name}: "${c.value}" is not a valid pattern.`;
        }
        out.push({ field: field as TextField, op: "matches", value: c.value, ...not });
      } else if (op === "in" && isText && Array.isArray(c.value) && c.value.length > 0 && c.value.length <= 30 && c.value.every((s) => typeof s === "string")) {
        out.push({ field: field as TextField, op: "in", value: c.value as string[], ...not });
      } else if (op === "between" && isNum && Array.isArray(c.value) && c.value.length === 2 && c.value.every((n) => n === null || typeof n === "number")) {
        out.push({ field: field as NumberField, op: "between", value: c.value as [number | null, number | null], ...not });
      } else if (op === "is" && isFlag && typeof c.value === "boolean") {
        out.push({ field: field as FlagField, op: "is", value: c.value, ...not });
      } else return `${name}: "${op}" does not fit field "${field}".`;
    }
    return out;
  };
  const test = checkConds(r.test, "test", true);
  if (typeof test === "string") return { error: test };
  const compare = checkConds(r.compare, "compare", false);
  if (typeof compare === "string") return { error: compare };
  const scope = checkConds(r.scope, "scope", false);
  if (typeof scope === "string") return { error: scope };
  const drop = (r.dropControls ?? []).filter((k): k is ControlKey => (CONTROL_KEYS as readonly string[]).includes(k));
  return {
    spec: {
      id: r.id,
      label: r.label!.trim(),
      question: r.question!.trim(),
      test,
      ...(compare.length ? { compare } : {}),
      ...(scope.length ? { scope } : {}),
      aLabel: r.aLabel!.trim(),
      bLabel: r.bLabel!.trim(),
      ...(drop.length ? { dropControls: drop } : {}),
      ...(typeof r.why === "string" && r.why.trim() ? { why: r.why.trim().slice(0, 400) } : {}),
    },
  };
}

// ── Statistics ──────────────────────────────────────────────────────────────

/** Inverse of a small symmetric matrix (Gauss-Jordan). Null when singular. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    const div = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Logistic regression on one-hot rows (each row lists its active columns;
 * column 0 is the factor), fit by Newton's method with a light ridge so rare
 * levels cannot blow up. Returns weights (last one is the intercept) and the
 * standard error of each, from the curvature at the fit.
 */
export function fitLogit(rows: number[][], y: number[], d: number, ridge = 1, iters = 25): { w: number[]; se: number[] } | null {
  const k = d + 1; // + intercept
  const w = new Array(k).fill(0);
  let cov: number[][] | null = null;
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    const g = new Array(k).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const act = [...rows[i], d];
      let z = 0;
      for (const j of act) z += w[j];
      const p = 1 / (1 + Math.exp(-z));
      const q = p * (1 - p);
      const e = y[i] - p;
      for (const a of act) {
        g[a] += e;
        for (const b of act) H[a][b] += q;
      }
    }
    for (let j = 0; j < d; j++) {
      H[j][j] += ridge;
      g[j] -= ridge * w[j];
    }
    H[d][d] += 1e-6;
    cov = invert(H);
    if (!cov) return null;
    let step = 0;
    for (let a = 0; a < k; a++) {
      let s = 0;
      for (let b = 0; b < k; b++) s += cov[a][b] * g[b];
      w[a] += s;
      step = Math.max(step, Math.abs(s));
    }
    if (step < 1e-7) break;
  }
  if (!cov) return null;
  return { w, se: cov.map((row, i) => Math.sqrt(Math.max(0, row[i]))) };
}

/** Two-sided p-value for a z score (normal approximation). */
export function pValue(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const dens = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
  const tail = dens * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * tail);
}

// ── Running a test ──────────────────────────────────────────────────────────

export const REPLY_WINDOW_DAYS = 45;
const MIN_GROUP = 40;
const MIN_REPLIES = 20;
const MIN_CONTROL_LEVEL = 30;

export type GroupStat = { sends: number; replies: number; rate: number; low: number; high: number; calls: number };
export type Verdict = "act" | "promising" | "nothing" | "thin";

export type FactorResult = {
  id: string;
  label: string;
  question: string;
  aLabel: string;
  bLabel: string;
  testedAt: string;
  verdict: Verdict;
  /** A gets more replies than B (up) or fewer (down), after the adjustments. */
  direction: "up" | "down" | null;
  a: GroupStat;
  b: GroupStat;
  /** Seb's own sends, raw numbers only (too few for the adjusted test). */
  youA: GroupStat | null;
  youB: GroupStat | null;
  /** Adjusted difference, in replies per 100 sends of group A, with a 95% range. */
  effectPer100: number | null;
  effectLow: number | null;
  effectHigh: number | null;
  p: number | null;
  halves: "agree" | "disagree" | "unknown";
  /** Plain-English summary for the card. */
  sentence: string;
};

function stat(rows: FactorRow[]): GroupStat {
  const sends = rows.length;
  const replies = rows.filter((r) => !!r.replied_at).length;
  const calls = rows.filter((r) => !!r.call_on).length;
  const ci = wilson(replies, sends);
  return { sends, replies, rate: sends ? replies / sends : 0, low: ci.low, high: ci.high, calls };
}

function controlLevel(key: ControlKey, r: FactorRow, v: Derived): string {
  switch (key) {
    case "country":
      return String(v.country_group);
    case "founded":
      return r.founded == null ? "?" : r.founded < 2000 ? "<2000" : r.founded < 2010 ? "2000s" : "2010+";
    case "employees":
      return r.employees == null ? "?" : r.employees < 25 ? "<25" : r.employees < 50 ? "25-49" : r.employees < 100 ? "50-99" : "100+";
    case "quality":
      return r.quality ?? "?";
    case "sender":
      return r.sender ?? "?";
    case "prior":
      return r.prior_sends > 0 ? "re-contact" : "first";
    case "kind":
      return r.subject_type;
  }
}

type Fit = { b: number; se: number; marg: (bShift: number) => number } | null;

/** Fit factor + controls on these rows; returns the factor's weight and a way to turn it into replies per 100. */
function fitFactor(rows: Array<{ r: FactorRow; v: Derived; a: boolean }>, controls: ControlKey[]): Fit {
  if (rows.length === 0) return null;
  const cols = new Map<string, number>();
  let d = 1; // column 0 = the factor
  for (const key of controls) {
    const counts = new Map<string, number>();
    for (const x of rows) {
      const l = controlLevel(key, x.r, x.v);
      counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    const levels = [...counts.entries()].filter(([, n]) => n >= MIN_CONTROL_LEVEL).sort((a, b) => b[1] - a[1]);
    // The most common level is the reference (no column); rarer ones share it.
    for (const [l] of levels.slice(1)) cols.set(`${key}=${l}`, d++);
  }
  const X = rows.map((x) => {
    const act: number[] = x.a ? [0] : [];
    for (const key of controls) {
      const j = cols.get(`${key}=${controlLevel(key, x.r, x.v)}`);
      if (j != null) act.push(j);
    }
    return act;
  });
  const y = rows.map((x) => (x.r.replied_at ? 1 : 0));
  const fit = fitLogit(X, y, d);
  if (!fit) return null;
  const { w, se } = fit;
  // Replies per 100 among group A: with the factor as fitted vs switched off.
  const marg = (bValue: number) => {
    let on = 0;
    let off = 0;
    let n = 0;
    X.forEach((act, i) => {
      if (!rows[i].a) return;
      let z = w[d];
      for (const j of act) if (j !== 0) z += w[j];
      on += 1 / (1 + Math.exp(-(z + bValue)));
      off += 1 / (1 + Math.exp(-z));
      n++;
    });
    return n ? ((on - off) / n) * 100 : 0;
  };
  return { b: w[0], se: se[0], marg };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (n: number) => n.toLocaleString("en-US");

/**
 * Test one factor on the sends that have had their full reply window by
 * `asOf` (YYYY-MM-DD). `youMatch` picks Seb's own sends for the raw "you"
 * numbers. Pure.
 */
export function testFactor(spec: FactorSpec, rows: FactorRow[], asOf: string, youMatch = /sebastian/i, prevMap?: Map<FactorRow, FactorRow | null>): FactorResult {
  const prev = prevMap ?? previousSends(rows);
  const cutoff = new Date(Date.parse(`${asOf}T00:00:00Z`) - REPLY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const groups: Array<{ r: FactorRow; v: Derived; a: boolean }> = [];
  for (const r of rows) {
    if (!r.mailing_id || r.sent_on > cutoff) continue;
    const v = derive(r, prev.get(r));
    if (!all(spec.scope, v)) continue;
    if (all(spec.test, v)) groups.push({ r, v, a: true });
    else if (!spec.compare || all(spec.compare, v)) groups.push({ r, v, a: false });
  }
  groups.sort((x, y) => (x.r.sent_on < y.r.sent_on ? -1 : x.r.sent_on > y.r.sent_on ? 1 : 0));
  const A = groups.filter((x) => x.a).map((x) => x.r);
  const B = groups.filter((x) => !x.a).map((x) => x.r);
  const a = stat(A);
  const b = stat(B);
  const mine = (list: FactorRow[]) => list.filter((r) => youMatch.test(r.sender ?? ""));
  const youA = mine(A).length ? stat(mine(A)) : null;
  const youB = mine(B).length ? stat(mine(B)) : null;
  const base = { id: spec.id, label: spec.label, question: spec.question, aLabel: spec.aLabel, bLabel: spec.bLabel, testedAt: asOf, a, b, youA, youB };

  if (a.sends < MIN_GROUP || b.sends < MIN_GROUP || a.replies + b.replies < MIN_REPLIES) {
    return { ...base, verdict: "thin", direction: null, effectPer100: null, effectLow: null, effectHigh: null, p: null, halves: "unknown", sentence: `Not enough data yet: ${num(a.sends)} sends in "${spec.aLabel}" and ${num(b.sends)} in "${spec.bLabel}" (needs ${MIN_GROUP} in each). Re-tested as more come in.` };
  }

  const controls = CONTROL_KEYS.filter((k) => !(spec.dropControls ?? []).includes(k));
  const full = fitFactor(groups, controls);
  if (!full || !Number.isFinite(full.se) || full.se === 0) {
    return { ...base, verdict: "thin", direction: null, effectPer100: null, effectLow: null, effectHigh: null, p: null, halves: "unknown", sentence: "The numbers could not be separated from the other factors (the two groups overlap too much with country, sender or size). Nothing to read here." };
  }
  const z = full.b / full.se;
  const p = pValue(z);
  const effect = full.marg(full.b);
  const lo = full.marg(full.b - 1.96 * full.se);
  const hi = full.marg(full.b + 1.96 * full.se);

  // Same direction in the older half and the newer half?
  const mid = Math.floor(groups.length / 2);
  const halfFit = (part: typeof groups) => (part.filter((x) => x.a).length >= 20 && part.filter((x) => !x.a).length >= 20 ? fitFactor(part, controls) : null);
  const h1 = halfFit(groups.slice(0, mid));
  const h2 = halfFit(groups.slice(mid));
  const halves: FactorResult["halves"] = h1 && h2 ? (Math.sign(h1.b) === Math.sign(h2.b) ? "agree" : "disagree") : "unknown";

  const direction = full.b >= 0 ? "up" : "down";
  const verdict: Verdict = p < 0.01 && halves === "agree" ? "act" : p < 0.1 ? "promising" : "nothing";
  const per100 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  const raw = `${pct(a.rate)} of "${spec.aLabel}" got a reply (${num(a.sends)} sends) vs ${pct(b.rate)} of "${spec.bLabel}" (${num(b.sends)}).`;
  const adjusted = `After accounting for country, company age, size, quality, sender and contact history: ${per100(effect)} replies per 100 sends (likely between ${per100(Math.min(lo, hi))} and ${per100(Math.max(lo, hi))}).`;
  const half = halves === "agree" ? " Same direction in older and newer sends." : halves === "disagree" ? " Older and newer sends point different ways." : "";
  const call =
    verdict === "act"
      ? direction === "up"
        ? "Act on it: do more of this."
        : "Act on it: avoid this."
      : verdict === "promising"
        ? "Promising, not proven. Re-tested next month."
        : "Nothing there. Not worth changing anything for.";
  return { ...base, verdict, direction, effectPer100: effect, effectLow: Math.min(lo, hi), effectHigh: Math.max(lo, hi), p, halves, sentence: `${raw} ${adjusted}${half} ${call}` };
}

/** Test many factors on the same rows (the previous-send lookup is shared). Pure. */
export function testFactors(specs: FactorSpec[], rows: FactorRow[], asOf: string, youMatch = /sebastian/i): FactorResult[] {
  const prev = previousSends(rows);
  return specs.map((s) => testFactor(s, rows, asOf, youMatch, prev));
}

// ── Starting library ────────────────────────────────────────────────────────

const E1_SUBJECT: Cond[] = [
  { field: "kind", op: "in", value: ["E1"] },
  { field: "subject", op: "known" },
];
const TITLE_KNOWN: Cond = { field: "title", op: "known" };
const TOP_TITLE = "owner|founder|co-founder|ceo|chief executive|president|principal|managing director|general manager|proprietor|partner";

export const FACTOR_LIBRARY: FactorSpec[] = [
  // Subject lines
  { id: "subject-name-name", label: "Name <> Name subject", question: 'Does an "Intro: X <> Y" subject change the reply rate?', scope: E1_SUBJECT, test: [{ field: "subject", op: "matches", value: "<\\s*>" }], aLabel: "X <> Y subjects", bLabel: "other E1 subjects" },
  { id: "subject-valstone-company", label: "Valstone <> Company subject", question: 'Is "Valstone <> Their Company" better or worse than other E1 subjects?', scope: E1_SUBJECT, test: [{ field: "subject", op: "matches", value: "valstone\\s*<\\s*>|<\\s*>\\s*valstone" }], aLabel: "Valstone <> Company", bLabel: "other E1 subjects" },
  { id: "subject-restaurant-date", label: "Restaurant and date subject", question: "Does a restaurant-and-date subject beat a generic lunch subject?", scope: E1_SUBJECT, test: [{ field: "subject_style", op: "in", value: ["specific"] }], compare: [{ field: "subject_style", op: "in", value: ["generic"] }], aLabel: "restaurant + date", bLabel: '"Lunch: Valstone" style' },
  { id: "subject-company-name", label: "Their company name in the subject", question: "Does putting the company's name in the subject help?", scope: E1_SUBJECT, test: [{ field: "company_in_subject", op: "is", value: true }], compare: [{ field: "company_in_subject", op: "is", value: false }], aLabel: "company named", bLabel: "company not named" },
  { id: "subject-first-name", label: "Their first name in the subject", question: "Does the contact's first name in the subject help?", scope: E1_SUBJECT, test: [{ field: "first_name_in_subject", op: "is", value: true }], compare: [{ field: "first_name_in_subject", op: "is", value: false }], aLabel: "first name in subject", bLabel: "no first name" },
  { id: "subject-short", label: "Short subject (25 characters or less)", question: "Do short subjects get more replies than longer ones?", scope: E1_SUBJECT, test: [{ field: "subject_length", op: "between", value: [1, 25] }], compare: [{ field: "subject_length", op: "between", value: [26, null] }], aLabel: "25 characters or less", bLabel: "longer" },
  { id: "subject-meet-ask", label: '"Meet" / "10 minutes" ask in the subject', question: 'Do subjects that ask for a meeting ("Let\'s meet in...", "10 minutes is all I ask") do better or worse?', scope: E1_SUBJECT, test: [{ field: "subject", op: "matches", value: "\\bmeet\\b|10 minutes|eager to connect|quick call" }], aLabel: "meeting ask in subject", bLabel: "other E1 subjects" },
  { id: "subject-event", label: "Trade show or event in the subject", question: "Does naming a trade show or event in the subject help?", scope: E1_SUBJECT, test: [{ field: "subject", op: "matches", value: "\\b(expo|show|conference|summit|tech hub|agri-tech|innotrans|week)\\b" }], aLabel: "event in subject", bLabel: "other E1 subjects" },
  // Timing
  { id: "lead-two-weeks", label: "Lunch date 2+ weeks out", question: "Does proposing a lunch at least two weeks after the send beat a date that is sooner?", scope: E1_SUBJECT, test: [{ field: "lead_days", op: "between", value: [14, null] }], compare: [{ field: "lead_days", op: "between", value: [0, 13] }], aLabel: "14+ days out", bLabel: "under 14 days out" },
  { id: "monday-morning", label: "Monday morning send", question: "Do sends that land Monday morning do worse (buried under the weekend pile)?", test: [{ field: "weekday", op: "between", value: [1, 1] }, { field: "hour", op: "between", value: [0, 11] }], compare: [{ field: "weekday", op: "between", value: [2, 4] }], aLabel: "Monday before noon", bLabel: "Tuesday to Thursday" },
  { id: "friday", label: "Friday send", question: "Do Friday sends get fewer replies than midweek?", test: [{ field: "weekday", op: "between", value: [5, 5] }], compare: [{ field: "weekday", op: "between", value: [2, 4] }], aLabel: "Friday", bLabel: "Tuesday to Thursday" },
  { id: "early-morning", label: "Sent before 9am", question: "Does landing before 9am (top of the inbox) help?", test: [{ field: "hour", op: "between", value: [5, 8] }], compare: [{ field: "hour", op: "between", value: [9, 17] }], aLabel: "5 to 9am", bLabel: "9am to 6pm" },
  { id: "evening", label: "Sent after 6pm", question: "Do evening sends do worse than daytime ones?", test: [{ field: "hour", op: "between", value: [18, 23] }], compare: [{ field: "hour", op: "between", value: [9, 17] }], aLabel: "after 6pm", bLabel: "9am to 6pm" },
  { id: "summer", label: "July and August", question: "Do summer sends get fewer replies?", test: [{ field: "month", op: "between", value: [7, 8] }], aLabel: "July and August", bLabel: "rest of the year" },
  { id: "december", label: "December", question: "Is December a dead month?", test: [{ field: "month", op: "between", value: [12, 12] }], aLabel: "December", bLabel: "rest of the year" },
  { id: "month-end", label: "Last week of the month", question: "Do sends in the last days of a month (month-end close) do worse?", test: [{ field: "day", op: "between", value: [25, 31] }], aLabel: "25th or later", bLabel: "rest of the month" },
  // Who it went to
  { id: "title-top", label: "Owner, CEO or president", question: "Do emails to the owner or CEO get more replies than to other titles?", scope: [TITLE_KNOWN], test: [{ field: "title", op: "matches", value: TOP_TITLE }], aLabel: "owner / CEO / president", bLabel: "other titles" },
  { id: "title-vp-director", label: "VP or director", question: "Are VPs and directors less likely to reply than the top person?", scope: [TITLE_KNOWN], test: [{ field: "title", op: "matches", value: "\\b(vp|vice president|director|head of)\\b" }, { field: "title", op: "matches", value: TOP_TITLE, not: true }], compare: [{ field: "title", op: "matches", value: TOP_TITLE }], aLabel: "VP / director", bLabel: "owner / CEO / president" },
  { id: "title-sales-marketing", label: "Sales or marketing title", question: "Do sales and marketing people reply more (they are used to cold email) but book fewer calls?", scope: [TITLE_KNOWN], test: [{ field: "title", op: "matches", value: "sales|marketing|business development|revenue|growth" }], aLabel: "sales / marketing", bLabel: "other titles" },
  { id: "email-generic", label: "Generic address (info@, sales@)", question: "How much worse is an info@ or sales@ address than a person's email?", test: [{ field: "email_kind", op: "in", value: ["generic"] }], compare: [{ field: "email_kind", op: "in", value: ["company"] }], aLabel: "info@ / sales@", bLabel: "a person's company email" },
  { id: "email-personal", label: "Personal address (gmail etc.)", question: "Does emailing a gmail or similar personal address do better or worse?", test: [{ field: "email_kind", op: "in", value: ["personal"] }], compare: [{ field: "email_kind", op: "in", value: ["company"] }], aLabel: "gmail / outlook / etc.", bLabel: "company email" },
  // Companies
  { id: "clean-founded-2010s", label: "Clean companies founded 2010 to 2019", question: "Within clean companies, do younger ones (2010 to 2019) reply more than pre-2000 ones?", scope: [{ field: "quality", op: "in", value: ["clean"] }], test: [{ field: "founded", op: "between", value: [2010, 2019] }], compare: [{ field: "founded", op: "between", value: [null, 1999] }], aLabel: "founded 2010 to 2019", bLabel: "founded before 2000", dropControls: ["founded"] },
  { id: "clean-canada-vs-us", label: "Canada vs US (clean companies)", question: "Within clean companies, how much better is Canada than the US?", scope: [{ field: "quality", op: "in", value: ["clean"] }], test: [{ field: "country_group", op: "in", value: ["Canada"] }], compare: [{ field: "country_group", op: "in", value: ["US"] }], aLabel: "Canada", bLabel: "US", dropControls: ["country"] },
  { id: "europe-vs-us", label: "Europe vs US", question: "Do European companies reply more than US ones?", test: [{ field: "country_group", op: "in", value: ["Europe"] }], compare: [{ field: "country_group", op: "in", value: ["US"] }], aLabel: "Europe", bLabel: "US", dropControls: ["country"] },
  { id: "size-15-49", label: "15 to 49 employees", question: "Are 15 to 49 person companies the sweet spot compared with 50+?", test: [{ field: "employees", op: "between", value: [15, 49] }], compare: [{ field: "employees", op: "between", value: [50, null] }], aLabel: "15 to 49 staff", bLabel: "50+ staff", dropControls: ["employees"] },
  // History
  { id: "recontact-gap-6m", label: "Re-contact within 6 months", question: "Is coming back within 6 months too soon?", scope: [{ field: "prior_sends", op: "between", value: [1, null] }], test: [{ field: "gap_days", op: "between", value: [0, 180] }], compare: [{ field: "gap_days", op: "between", value: [181, null] }], aLabel: "within 6 months", bLabel: "after 6 months", dropControls: ["prior"] },
  { id: "recontact-new-person", label: "Re-contact a different person", question: "On a re-contact, does a different person at the company reply more than the same one again?", scope: [{ field: "prior_sends", op: "between", value: [1, null] }], test: [{ field: "same_person", op: "is", value: false }], compare: [{ field: "same_person", op: "is", value: true }], aLabel: "a different person", bLabel: "the same person again", dropControls: ["prior"] },
];

// ── Trends: last 4 weeks vs the 4 before ───────────────────────────────────

export const EARLY_REPLY_DAYS = 14;

export type TrendWeek = { week: string; sends: number; replies14: number; cleanReplies14: number; calls: number };
export type TrendSide = { weeks: TrendWeek[]; last4: TrendTotals; prev4: TrendTotals };
export type TrendTotals = { sends: number; replyRate14: number; cleanPer100: number; calls: number };
export type Trends = { asOf: string; you: TrendSide; team: TrendSide };

function monday(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Weekly numbers with a 14-day reply window (most replies come within two
 * weeks), so a change shows about two weeks after the sends instead of six.
 * Only weeks whose sends have all had 14 days. Calls are counted in the week
 * they happened. Pure.
 */
export function buildTrends(rows: FactorRow[], asOf: string, youMatch = /sebastian/i, weeks = 12): Trends {
  const lastWeek = monday(new Date(Date.parse(`${asOf}T00:00:00Z`) - (EARLY_REPLY_DAYS + 7) * 86_400_000).toISOString().slice(0, 10));
  const list: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) list.push(new Date(Date.parse(`${lastWeek}T00:00:00Z`) - i * 7 * 86_400_000).toISOString().slice(0, 10));
  const side = (pick: (r: FactorRow) => boolean): TrendSide => {
    const by = new Map(list.map((w) => [w, { week: w, sends: 0, replies14: 0, cleanReplies14: 0, calls: 0 }]));
    for (const r of rows) {
      if (!r.mailing_id || !pick(r)) continue;
      const w = by.get(monday(r.sent_on));
      if (w) {
        w.sends++;
        const days = r.replied_at ? (Date.parse(r.replied_at) - Date.parse(`${r.sent_on}T00:00:00Z`)) / 86_400_000 : Infinity;
        if (days <= EARLY_REPLY_DAYS + 1) {
          w.replies14++;
          if (r.quality === "clean") w.cleanReplies14++;
        }
      }
      if (r.call_on) {
        const cw = by.get(monday(r.call_on));
        if (cw) cw.calls++;
      }
    }
    const weeksOut = list.map((w) => by.get(w)!);
    const totals = (ws: TrendWeek[]): TrendTotals => {
      const sends = ws.reduce((s, w) => s + w.sends, 0);
      const rep = ws.reduce((s, w) => s + w.replies14, 0);
      const clean = ws.reduce((s, w) => s + w.cleanReplies14, 0);
      return { sends, replyRate14: sends ? rep / sends : 0, cleanPer100: sends ? (clean / sends) * 100 : 0, calls: ws.reduce((s, w) => s + w.calls, 0) };
    };
    return { weeks: weeksOut, last4: totals(weeksOut.slice(-4)), prev4: totals(weeksOut.slice(-8, -4)) };
  };
  return { asOf, you: side((r) => youMatch.test(r.sender ?? "")), team: side(() => true) };
}
