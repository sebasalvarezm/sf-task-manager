// ── Outreach quality ("BS" scoring) ─────────────────────────────────────────
//
// Scores each outreach email against three signals of a poor acquisition
// target, read from the Salesforce Account it was sent to:
//
//   geography  → Account.BillingCountry outside the tier-one list
//   founded    → Account.Year_Established__c after the cutoff (too young)
//   employees  → Account.NumberOfEmployees below the floor (too small)
//
// Any TWO of the three firing makes the email "BS". One alone does not — a
// young company with real headcount in a core market is a legitimate target.
//
// A BLANK field counts against the email too. That is deliberate: an email we
// cannot justify from the CRM is not a justified email. But blanks are tracked
// separately in `missing` so the UI can offer the sender an input box to fill
// the value in (and push it to Salesforce) rather than just scolding them.
//
// This module is deliberately free of Salesforce, Supabase and `@/` imports so
// the vitest suite — which resolves by relative path only — can cover it.

export type QualityFlagKey = "geography" | "founded" | "employees";

export const QUALITY_FLAG_KEYS: readonly QualityFlagKey[] = [
  "geography",
  "founded",
  "employees",
] as const;

/** Short labels for pills and captions. */
export const QUALITY_FLAG_LABELS: Record<QualityFlagKey, string> = {
  geography: "Geography",
  founded: "Founded",
  employees: "Headcount",
};

export type QualityThresholds = {
  /** Canonical display names of the acceptable countries. */
  tierOneCountries: string[];
  /** Founded strictly AFTER this year flags. 2019 → 2020+ is suspicious. */
  foundedAfterYear: number;
  /** Fewer than this many employees flags. 15 → 14 is suspicious, 15 is fine. */
  minEmployees: number;
  /** How many flags make an email BS. */
  bsFlagCount: number;
};

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  tierOneCountries: [
    "United States",
    "Canada",
    "Ireland",
    "United Kingdom",
    "Netherlands",
    "Australia",
    "New Zealand",
  ],
  foundedAfterYear: 2019,
  minEmployees: 15,
  bsFlagCount: 2,
};

export type QualityVerdict = {
  /** Every signal counting against this email. */
  flags: QualityFlagKey[];
  /** The subset of `flags` that fired only because Salesforce is blank. */
  missing: QualityFlagKey[];
  isBs: boolean;
};

// ── Country matching ────────────────────────────────────────────────────────

/**
 * Collapses a country string to a comparison key: lowercase, alphanumerics
 * only. "U.S.A." / "usa" / "U S A" all land on "usa".
 */
function countryKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Spelling variants → canonical display name. Salesforce BillingCountry is free
// text in this org, so the same country arrives half a dozen ways and every
// unmatched variant would otherwise read as a false geography flag.
//
// Note "ca" → Canada, not California: in Salesforce the state lives in
// BillingState, so a two-letter *country* of CA is Canada.
const COUNTRY_ALIASES: Record<string, string> = {};

function registerCountry(canonical: string, aliases: string[]): void {
  COUNTRY_ALIASES[countryKey(canonical)] = canonical;
  for (const a of aliases) COUNTRY_ALIASES[countryKey(a)] = canonical;
}

registerCountry("United States", [
  "us",
  "usa",
  "u.s.",
  "u.s.a.",
  "united states of america",
  "united states america",
  "america",
  "the united states",
]);
registerCountry("Canada", ["ca", "can"]);
registerCountry("United Kingdom", [
  "uk",
  "u.k.",
  "gb",
  "gbr",
  "britain",
  "great britain",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "united kingdom of great britain and northern ireland",
]);
registerCountry("Ireland", ["ie", "irl", "eire", "republic of ireland"]);
registerCountry("Netherlands", [
  "nl",
  "nld",
  "holland",
  "the netherlands",
  "nederland",
]);
registerCountry("Australia", ["au", "aus"]);
registerCountry("New Zealand", ["nz", "nzl"]);

/**
 * Maps a raw BillingCountry to a canonical display name.
 *
 * Returns null for blank input. Unrecognised countries pass through trimmed
 * (they are still real countries — just not tier one — and the UI displays
 * whatever Salesforce holds).
 */
export function canonicalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return COUNTRY_ALIASES[countryKey(trimmed)] ?? trimmed;
}

/** True when `raw` is one of the configured tier-one countries. */
export function isTierOneCountry(
  raw: string | null | undefined,
  tierOneCountries: readonly string[],
): boolean {
  const canonical = canonicalizeCountry(raw);
  if (!canonical) return false;
  const target = countryKey(canonical);
  // Canonicalize the configured side too, so an admin who types "USA" into the
  // rules editor still matches an account holding "United States".
  return tierOneCountries.some((c) => {
    const canonicalConfigured = canonicalizeCountry(c);
    return canonicalConfigured != null && countryKey(canonicalConfigured) === target;
  });
}

// ── Field parsing ───────────────────────────────────────────────────────────

const MIN_PLAUSIBLE_YEAR = 1800;
const MAX_PLAUSIBLE_EMPLOYEES = 1_000_000;

/**
 * Pulls a founding year out of Year_Established__c, which is a TEXT field in
 * Salesforce and so arrives as "1974", "Est. 1974", "1974-01-01" or junk.
 */
export function extractYear(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = /\b(1[89]\d{2}|20\d{2})\b/.exec(String(raw));
  if (!match) return null;
  const year = Number(match[1]);
  if (year < MIN_PLAUSIBLE_YEAR || year > new Date().getFullYear()) return null;
  return year;
}

/**
 * Validates a year typed by a user, returning the 4-digit STRING Salesforce
 * wants (Year_Established__c is text, not a number, everywhere in this repo).
 */
export function parseYearInput(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!/^\d{4}$/.test(trimmed)) return null;
  const year = Number(trimmed);
  if (year < MIN_PLAUSIBLE_YEAR || year > new Date().getFullYear()) return null;
  return trimmed;
}

/** Validates an employee count typed by a user. Whole positive numbers only. */
export function parseEmployeesInput(
  raw: string | number | null | undefined,
): number | null {
  if (raw == null || raw === "") return null;
  const trimmed = typeof raw === "number" ? String(raw) : raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_PLAUSIBLE_EMPLOYEES) return null;
  return n;
}

/** Validates a country typed by a user. Free text — Salesforce validates the rest. */
export function parseCountryInput(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export type QualityInput = {
  country: string | null;
  yearEstablished: string | null;
  numberOfEmployees: number | null;
};

export type ScoreOptions = {
  /**
   * False when the SOQL fallback had to drop Account.Year_Established__c
   * because the org lacks the field. The founded criterion is then SKIPPED
   * rather than counted as blank — otherwise every row would read as missing
   * and the BS rate would sit near 100%.
   */
  foundedFieldAvailable?: boolean;
};

export function scoreAccountQuality(
  input: QualityInput,
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
  opts: ScoreOptions = {},
): QualityVerdict {
  const flags: QualityFlagKey[] = [];
  const missing: QualityFlagKey[] = [];

  // Geography
  const country = canonicalizeCountry(input.country);
  if (!country) {
    flags.push("geography");
    missing.push("geography");
  } else if (!isTierOneCountry(country, thresholds.tierOneCountries)) {
    flags.push("geography");
  }

  // Founded — skipped entirely when the field is absent from the org.
  if (opts.foundedFieldAvailable !== false) {
    const year = extractYear(input.yearEstablished);
    if (year == null) {
      flags.push("founded");
      missing.push("founded");
    } else if (year > thresholds.foundedAfterYear) {
      flags.push("founded");
    }
  }

  // Headcount. A stored 0 is treated as unknown rather than as a real value:
  // no company worth emailing has zero staff, so 0 means "nobody filled this
  // in" and the sender should get an input box, not a verdict.
  const employees = input.numberOfEmployees;
  if (employees == null || employees <= 0) {
    flags.push("employees");
    missing.push("employees");
  } else if (employees < thresholds.minEmployees) {
    flags.push("employees");
  }

  return {
    flags,
    missing,
    isBs: flags.length >= thresholds.bsFlagCount,
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/** Structural shape of a scorable row — kept local to avoid a Salesforce import. */
export type ScorableOutreachRow = QualityInput & {
  activityDate: string; // yyyy-MM-dd
  owner: string;
};

/** Structurally compatible with `Bucket` from lib/date-ranges. */
export type QualityBucket = {
  label: string;
  start: string; // yyyy-MM-dd
  end: string; // yyyy-MM-dd
};

export type QualityTotals = {
  sent: number;
  bs: number;
  /** Fraction 0–1, matching the existing `conversion.rate` convention. */
  rate: number;
};

export type QualityBucketRow = QualityTotals & {
  label: string;
  start: string;
};

export type QualityPersonRow = QualityTotals & {
  owner: string;
};

export type OutreachQualityAggregate = {
  totals: QualityTotals;
  /**
   * How often each signal fired, counted across BS emails only. A BS email
   * carries two or more flags by definition, so these sum to MORE than
   * `totals.bs` — label it "reasons cited", never treat it as a breakdown of
   * the total.
   */
  reasonCounts: Record<QualityFlagKey, number>;
  byBucket: QualityBucketRow[];
  byPerson: QualityPersonRow[];
  foundedFieldAvailable: boolean;
};

function rate(bs: number, sent: number): number {
  return sent === 0 ? 0 : bs / sent;
}

export function aggregateOutreachQuality(
  rows: readonly ScorableOutreachRow[],
  buckets: readonly QualityBucket[],
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
  foundedFieldAvailable = true,
): OutreachQualityAggregate {
  const opts: ScoreOptions = { foundedFieldAvailable };

  const reasonCounts: Record<QualityFlagKey, number> = {
    geography: 0,
    founded: 0,
    employees: 0,
  };

  const bucketTally = buckets.map((b) => ({
    label: b.label,
    start: b.start,
    end: b.end,
    sent: 0,
    bs: 0,
  }));
  const personTally = new Map<string, { sent: number; bs: number }>();

  let sent = 0;
  let bs = 0;

  for (const row of rows) {
    const verdict = scoreAccountQuality(row, thresholds, opts);
    sent += 1;
    if (verdict.isBs) {
      bs += 1;
      for (const flag of verdict.flags) reasonCounts[flag] += 1;
    }

    // yyyy-MM-dd sorts lexicographically, so plain string comparison is a
    // correct date range test here.
    const bucket = bucketTally.find(
      (b) => row.activityDate >= b.start && row.activityDate <= b.end,
    );
    if (bucket) {
      bucket.sent += 1;
      if (verdict.isBs) bucket.bs += 1;
    }

    const person = personTally.get(row.owner) ?? { sent: 0, bs: 0 };
    person.sent += 1;
    if (verdict.isBs) person.bs += 1;
    personTally.set(row.owner, person);
  }

  return {
    totals: { sent, bs, rate: rate(bs, sent) },
    reasonCounts,
    byBucket: bucketTally.map((b) => ({
      label: b.label,
      start: b.start,
      sent: b.sent,
      bs: b.bs,
      rate: rate(b.bs, b.sent),
    })),
    byPerson: [...personTally.entries()]
      .map(([owner, t]) => ({
        owner,
        sent: t.sent,
        bs: t.bs,
        rate: rate(t.bs, t.sent),
      }))
      .sort((a, b) => b.rate - a.rate || b.bs - a.bs),
    foundedFieldAvailable,
  };
}

// ── Threshold validation (shared by the settings loader and the PUT route) ──

/**
 * Coerces an untrusted object (a Supabase JSONB blob, or a request body) into
 * valid thresholds, falling back field-by-field to the defaults. A malformed
 * settings row must never take the Stats page down.
 */
export function coerceQualityThresholds(raw: unknown): QualityThresholds {
  const d = DEFAULT_QUALITY_THRESHOLDS;
  if (raw == null || typeof raw !== "object") return { ...d };
  const o = raw as Record<string, unknown>;

  const countries = Array.isArray(o.tierOneCountries)
    ? o.tierOneCountries
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && c.length <= 80)
    : [];

  const foundedAfterYear =
    typeof o.foundedAfterYear === "number" &&
    Number.isInteger(o.foundedAfterYear) &&
    o.foundedAfterYear >= MIN_PLAUSIBLE_YEAR &&
    o.foundedAfterYear <= new Date().getFullYear()
      ? o.foundedAfterYear
      : d.foundedAfterYear;

  const minEmployees =
    typeof o.minEmployees === "number" &&
    Number.isInteger(o.minEmployees) &&
    o.minEmployees > 0 &&
    o.minEmployees <= MAX_PLAUSIBLE_EMPLOYEES
      ? o.minEmployees
      : d.minEmployees;

  const bsFlagCount =
    typeof o.bsFlagCount === "number" &&
    Number.isInteger(o.bsFlagCount) &&
    o.bsFlagCount >= 1 &&
    o.bsFlagCount <= QUALITY_FLAG_KEYS.length
      ? o.bsFlagCount
      : d.bsFlagCount;

  return {
    // An empty country list would flag every email on geography, which is
    // never what an admin means — fall back to the defaults instead.
    tierOneCountries: countries.length > 0 ? countries : [...d.tierOneCountries],
    foundedAfterYear,
    minEmployees,
    bsFlagCount,
  };
}
