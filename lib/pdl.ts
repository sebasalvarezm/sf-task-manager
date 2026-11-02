/**
 * People Data Labs Company Enrichment, used only for where a company's staff
 * sit (employee_count_by_country) and its HQ town. Same pattern as
 * lib/parallel.ts: callers pass a client, tests use the mock, and the real
 * client refuses to run without PDL_API_KEY.
 */

export type CompanyStaff = {
  checked: boolean;
  found: boolean;
  total: number | null;
  byCountry: Record<string, number>;
  /** Share of located staff in North America, Europe and ANZ, 0 to 1, or null when unknown. */
  coreShare: number | null;
  /** Set when most located staff are outside the core regions. Flag only, never a filter. */
  flag: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
};

export interface PdlClient {
  readonly mock: boolean;
  /** null when PDL has no record (no credit is used for a miss). */
  enrichCompany(website: string): Promise<{ employee_count?: number | null; employee_count_by_country?: Record<string, number> | null; location?: { locality?: string | null; region?: string | null; country?: string | null } | null } | null>;
}

export function realPdlClient(): PdlClient {
  const key = process.env.PDL_API_KEY?.trim();
  if (!key) throw new Error("PDL_API_KEY is not set in Vercel. Staff check skipped.");
  return {
    mock: false,
    async enrichCompany(website) {
      const url = `https://api.peopledatalabs.com/v5/company/enrich?website=${encodeURIComponent(website)}`;
      const res = await fetch(url, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null;
      const text = await res.text();
      if (!res.ok) throw new Error(`PDL ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    },
  };
}

export function mockPdlClient(data: Record<string, Awaited<ReturnType<PdlClient["enrichCompany"]>>>): PdlClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    mock: true,
    calls,
    async enrichCompany(website) {
      calls.push(website);
      return data[website] ?? null;
    },
  };
}

const NORTH_AMERICA = ["united states", "canada", "mexico"];
const ANZ = ["australia", "new zealand"];
const EUROPE = [
  "united kingdom", "ireland", "france", "germany", "netherlands", "belgium", "luxembourg", "switzerland", "austria", "italy", "spain",
  "portugal", "denmark", "sweden", "norway", "finland", "iceland", "poland", "czechia", "czech republic", "slovakia", "hungary", "romania",
  "bulgaria", "greece", "croatia", "slovenia", "estonia", "latvia", "lithuania", "malta", "cyprus", "serbia", "bosnia and herzegovina",
  "montenegro", "north macedonia", "albania", "ukraine", "moldova", "liechtenstein", "monaco", "andorra",
];
const CORE = new Set([...NORTH_AMERICA, ...ANZ, ...EUROPE]);

/** Turn a PDL record (or a miss) into what the review card shows. */
export function summarizeStaff(rec: Awaited<ReturnType<PdlClient["enrichCompany"]>>, checked = true): CompanyStaff {
  const empty: CompanyStaff = { checked, found: false, total: null, byCountry: {}, coreShare: null, flag: null, city: null, region: null, country: null };
  if (!rec) return empty;
  const byCountry = { ...(rec.employee_count_by_country ?? {}) };
  let located = 0;
  let core = 0;
  for (const [country, n] of Object.entries(byCountry)) {
    if (country === "other_uncategorized" || !Number.isFinite(n)) continue;
    located += n;
    if (CORE.has(country.toLowerCase())) core += n;
  }
  const coreShare = located > 0 ? core / located : null;
  const cap = (s: string | null | undefined) => (s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : null);
  return {
    checked,
    found: true,
    total: rec.employee_count ?? (located || null),
    byCountry,
    coreShare,
    flag: coreShare !== null && coreShare < 0.5 ? "Most staff outside North America, Europe and ANZ" : null,
    city: cap(rec.location?.locality),
    region: cap(rec.location?.region),
    country: cap(rec.location?.country),
  };
}

/** "US 34 · Canada 3 · India 12", largest first, for the card. */
export function staffLine(staff: CompanyStaff | null | undefined): string {
  if (!staff || !staff.checked) return "Staff: not checked";
  if (!staff.found) return "Staff: unknown";
  const parts = Object.entries(staff.byCountry)
    .filter(([c]) => c !== "other_uncategorized")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([c, n]) => `${c === "united states" ? "US" : c === "united kingdom" ? "UK" : c.replace(/\b\w/g, (x) => x.toUpperCase())} ${n}`);
  return parts.length ? `Staff: ${parts.join(" · ")}` : "Staff: unknown";
}
