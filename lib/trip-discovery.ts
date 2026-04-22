import Anthropic from "@anthropic-ai/sdk";
import { CDMAccount } from "./salesforce-trip";

// ── Types ────────────────────────────────────────────────────────────────────

export type DiscoveredCompany = {
  name: string;
  website: string | null;
  description: string;
  subVertical: string;
  city: string | null;
  state: string | null;
  employeesEstimate: number | null;
  ownership: "independent" | "pe_vc" | "aggregator";
  ownershipDetail: string | null;
};

// ── CDM sub-verticals ────────────────────────────────────────────────────────

const CDM_VERTICALS = [
  {
    name: "Contractor",
    searchTerms:
      "construction operations software, estimating software, project delivery, bid management, construction scheduling",
  },
  {
    name: "Structure Design & Analysis",
    searchTerms:
      "structural engineering software, bridge design, civil infrastructure analysis, FEA structural, foundation design",
  },
  {
    name: "Safety & Compliance",
    searchTerms:
      "EHS software, construction safety management, compliance management, OSHA reporting, safety inspection software",
  },
  {
    name: "Bulk Materials",
    searchTerms:
      "aggregate management software, concrete dispatch, asphalt plant software, bulk material tracking, ready-mix software",
  },
  {
    name: "Mining",
    searchTerms:
      "mining operations software, mine planning, resource estimation, mining fleet management, mineral processing software",
  },
  {
    name: "Waste",
    searchTerms:
      "waste management software, recycling operations, waste hauler software, landfill management, environmental services software",
  },
  {
    name: "Equipment",
    searchTerms:
      "heavy equipment management software, fleet tracking, equipment rental software, construction equipment telematics",
  },
  {
    name: "Bulk Liquids",
    searchTerms:
      "fuel management software, chemical logistics, liquid bulk transport, tank monitoring, petroleum distribution software",
  },
  {
    name: "Forest & Lumber",
    searchTerms:
      "forestry management software, lumber tracking, timber operations, wood products ERP, sawmill software",
  },
];

// Software buy-and-hold aggregators to EXCLUDE
const AGGREGATORS = [
  "Constellation Software",
  "Volaris Group",
  "Harris Computer",
  "Jonas Software",
  "Vela Software",
  "Perseus Group",
  "Lumine Group",
  "Topicus",
  "N-able",
  "Arcadea Group",
  "Roper Technologies",
  "Fortive",
  "Trimble",
  "Valsoft",
  "Valstonecorp",
];

// ── Search one sub-vertical ──────────────────────────────────────────────────

async function searchVertical(
  client: Anthropic,
  vertical: (typeof CDM_VERTICALS)[number],
  location: string,
  radiusMiles: number
): Promise<DiscoveredCompany[]> {
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Find software companies located within roughly ${radiusMiles} driving miles of ${location} that serve the ${vertical.name} industry.

**CRITICAL GEOGRAPHIC CONSTRAINT:**
Every company MUST be physically headquartered within ${radiusMiles} miles of ${location}. Do NOT include companies in other states or regions, even if they would otherwise fit the profile. When in doubt, exclude.

If ${location} is in the USA, only return US companies in the same state or an immediately neighboring state. Do NOT return companies from across the country (e.g., if the trip is to Colorado, do NOT include Florida, Wisconsin, or Oklahoma companies).

Search terms to guide your research: ${vertical.searchTerms}

**ACQUISITION PROFILE (critical — prioritize these):**
We are Valstone, an M&A firm that acquires small vertical software companies. Our target profile:
- **Employee count: 20 to 150 (sweet spot is 30-80)**
- Bootstrapped or lightly-funded (not venture-backed mega-rounds)
- Niche, specialized, often founder-led
- B2B software for a specific industry vertical
- Usually $3M–$30M ARR

**AVOID returning:**
- Large public software companies (Procore, Autodesk, Oracle, etc.)
- Unicorns or heavily VC-funded companies (Series C+)
- Companies with 200+ employees
- Household-name enterprise software

**PREFER returning:**
- Smaller, specialized companies that most people haven't heard of
- Regional players serving a specific industry
- Founder-owned companies with stable niches
- Companies that appear on LinkedIn with 20-150 employees

Requirements:
- Must be SOFTWARE companies (SaaS, desktop software, or cloud platforms)
- Must serve the ${vertical.name} vertical specifically
- Located near ${location} (same state or neighboring area)
- Return up to 10 companies

For each company, return:
- name: company name
- website: company website URL (if known)
- description: 1-2 sentences about what they do
- city: city where they're headquartered
- state: US state abbreviation (or province/country if outside US)
- employees: your best estimate of employee count (integer, or null if truly unknown)

Return a JSON array only (no markdown, no explanation):
[{"name":"...","website":"...","description":"...","city":"...","state":"...","employees":45}]

If you cannot find any relevant companies, return [].`,
        },
      ],
    });

    const text =
      resp.content[0].type === "text" ? resp.content[0].text : "";
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as Array<{
      name: string;
      website?: string;
      description: string;
      city?: string;
      state?: string;
      employees?: number | null;
    }>;

    // Filter out companies clearly too large for Valstone's profile (>200 employees)
    const inSizeRange = (parsed ?? []).filter((c) => {
      if (c.employees == null) return true; // keep if unknown
      return c.employees <= 200;
    });

    return inSizeRange.slice(0, 10).map((c) => ({
      name: c.name,
      website: c.website ?? null,
      description: c.description,
      subVertical: vertical.name,
      city: c.city ?? null,
      state: c.state ?? null,
      employeesEstimate: c.employees ?? null,
      ownership: "independent" as const,
      ownershipDetail: null,
    }));
  } catch {
    return [];
  }
}

// ── Check ownership of discovered companies ─────────────────────────────────

async function checkOwnershipBatch(
  client: Anthropic,
  companies: DiscoveredCompany[]
): Promise<DiscoveredCompany[]> {
  if (companies.length === 0) return [];

  const aggregatorList = AGGREGATORS.join(", ");
  const companyList = companies
    .map((c, i) => `${i + 1}. ${c.name}${c.website ? ` (${c.website})` : ""}`)
    .join("\n");

  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `For each company below, determine its ownership status:
- "independent" = privately held, no known acquirer
- "pe_vc" = backed by private equity or venture capital
- "aggregator" = acquired by a buy-and-hold software aggregator

Known software aggregators to check against: ${aggregatorList}

Companies:
${companyList}

Return a JSON array with one entry per company (same order):
[{"index":0,"ownership":"independent","detail":null},{"index":1,"ownership":"aggregator","detail":"Acquired by Constellation Software (Volaris Group) in 2021"}]

"detail" is a short note only if ownership is "pe_vc" or "aggregator" (who owns them).
Return [] if you cannot determine ownership for any.`,
        },
      ],
    });

    const text =
      resp.content[0].type === "text" ? resp.content[0].text : "";
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as Array<{
      index: number;
      ownership: string;
      detail: string | null;
    }>;

    for (const entry of parsed ?? []) {
      if (entry.index >= 0 && entry.index < companies.length) {
        const o = entry.ownership as "independent" | "pe_vc" | "aggregator";
        if (["independent", "pe_vc", "aggregator"].includes(o)) {
          companies[entry.index].ownership = o;
          companies[entry.index].ownershipDetail = entry.detail;
        }
      }
    }
  } catch {
    // Non-fatal: leave all as "independent"
  }

  return companies;
}

// ── US state adjacency map (for geographic filtering) ───────────────────────
// Each state maps to itself + bordering states. Used to reject discovery
// results that are clearly far from the user's trip location.

const STATE_ADJACENCY: Record<string, string[]> = {
  AL: ["AL", "FL", "GA", "MS", "TN"],
  AK: ["AK"],
  AZ: ["AZ", "CA", "CO", "NM", "NV", "UT"],
  AR: ["AR", "LA", "MO", "MS", "OK", "TN", "TX"],
  CA: ["CA", "AZ", "NV", "OR"],
  CO: ["CO", "AZ", "KS", "NE", "NM", "OK", "UT", "WY"],
  CT: ["CT", "MA", "NY", "RI"],
  DE: ["DE", "MD", "NJ", "PA"],
  FL: ["FL", "AL", "GA"],
  GA: ["GA", "AL", "FL", "NC", "SC", "TN"],
  HI: ["HI"],
  ID: ["ID", "MT", "NV", "OR", "UT", "WA", "WY"],
  IL: ["IL", "IN", "IA", "KY", "MO", "WI"],
  IN: ["IN", "IL", "KY", "MI", "OH"],
  IA: ["IA", "IL", "MN", "MO", "NE", "SD", "WI"],
  KS: ["KS", "CO", "MO", "NE", "OK"],
  KY: ["KY", "IL", "IN", "MO", "OH", "TN", "VA", "WV"],
  LA: ["LA", "AR", "MS", "TX"],
  ME: ["ME", "NH"],
  MD: ["MD", "DE", "PA", "VA", "WV", "DC"],
  MA: ["MA", "CT", "NH", "NY", "RI", "VT"],
  MI: ["MI", "IN", "OH", "WI"],
  MN: ["MN", "IA", "ND", "SD", "WI"],
  MS: ["MS", "AL", "AR", "LA", "TN"],
  MO: ["MO", "AR", "IA", "IL", "KS", "KY", "NE", "OK", "TN"],
  MT: ["MT", "ID", "ND", "SD", "WY"],
  NE: ["NE", "CO", "IA", "KS", "MO", "SD", "WY"],
  NV: ["NV", "AZ", "CA", "ID", "OR", "UT"],
  NH: ["NH", "MA", "ME", "VT"],
  NJ: ["NJ", "DE", "NY", "PA"],
  NM: ["NM", "AZ", "CO", "OK", "TX", "UT"],
  NY: ["NY", "CT", "MA", "NJ", "PA", "VT"],
  NC: ["NC", "GA", "SC", "TN", "VA"],
  ND: ["ND", "MN", "MT", "SD"],
  OH: ["OH", "IN", "KY", "MI", "PA", "WV"],
  OK: ["OK", "AR", "CO", "KS", "MO", "NM", "TX"],
  OR: ["OR", "CA", "ID", "NV", "WA"],
  PA: ["PA", "DE", "MD", "NJ", "NY", "OH", "WV"],
  RI: ["RI", "CT", "MA"],
  SC: ["SC", "GA", "NC"],
  SD: ["SD", "IA", "MN", "MT", "ND", "NE", "WY"],
  TN: ["TN", "AL", "AR", "GA", "KY", "MO", "MS", "NC", "VA"],
  TX: ["TX", "AR", "LA", "NM", "OK"],
  UT: ["UT", "AZ", "CO", "ID", "NM", "NV", "WY"],
  VT: ["VT", "MA", "NH", "NY"],
  VA: ["VA", "KY", "MD", "NC", "TN", "WV", "DC"],
  WA: ["WA", "ID", "OR"],
  WV: ["WV", "KY", "MD", "OH", "PA", "VA"],
  WI: ["WI", "IA", "IL", "MI", "MN"],
  WY: ["WY", "CO", "ID", "MT", "NE", "SD", "UT"],
  DC: ["DC", "MD", "VA"],
};

function stateAbbrevFromLocation(location: string): string | null {
  // Try to extract a 2-letter state abbreviation from the user's input
  // e.g., "Denver, CO" → "CO", "1 Lake Ave, Colorado Springs, CO 80906" → "CO"
  const match = location.match(/\b([A-Z]{2})\b/);
  if (match) return match[1];
  return null;
}

function filterByGeography(
  companies: DiscoveredCompany[],
  userLocation: string
): DiscoveredCompany[] {
  const userState = stateAbbrevFromLocation(userLocation);
  if (!userState || !STATE_ADJACENCY[userState]) return companies;

  const allowed = new Set(STATE_ADJACENCY[userState]);

  return companies.filter((c) => {
    if (!c.state) return true; // keep if unknown — Claude might not have returned it
    const companyState = c.state.toUpperCase().trim();
    return allowed.has(companyState);
  });
}

// ── Deduplicate against existing SF accounts ────────────────────────────────

function deduplicateAgainstSF(
  discovered: DiscoveredCompany[],
  sfAccounts: CDMAccount[]
): DiscoveredCompany[] {
  const sfNames = new Set(
    sfAccounts.map((a) => a.Name.toLowerCase().trim())
  );
  const sfDomains = new Set(
    sfAccounts
      .map((a) => {
        if (!a.Website) return null;
        return a.Website.replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .split("/")[0]
          .toLowerCase();
      })
      .filter(Boolean) as string[]
  );

  return discovered.filter((c) => {
    // Check name match
    if (sfNames.has(c.name.toLowerCase().trim())) return false;

    // Check domain match
    if (c.website) {
      const domain = c.website
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
        .toLowerCase();
      if (sfDomains.has(domain)) return false;
    }

    return true;
  });
}

// ── Main discovery function ─────────────────────────────────────────────────

export async function discoverCompanies(
  location: string,
  radiusMiles: number,
  sfAccounts: CDMAccount[]
): Promise<{
  companies: DiscoveredCompany[];
  stats: { searched: number; found: number; deduped: number; filteredByGeo: number; final: number };
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Step 1: Search all 9 verticals in parallel
  const verticalResults = await Promise.all(
    CDM_VERTICALS.map((v) => searchVertical(client, v, location, radiusMiles))
  );

  // Merge and deduplicate by name (case-insensitive)
  const seen = new Set<string>();
  const allFound: DiscoveredCompany[] = [];
  for (const batch of verticalResults) {
    for (const c of batch) {
      const key = c.name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        allFound.push(c);
      }
    }
  }

  // Step 2: Geographic filter — drop companies outside the trip state and its neighbors
  const afterGeo = filterByGeography(allFound, location);

  // Step 3: Remove companies already in Salesforce
  const afterDedup = deduplicateAgainstSF(afterGeo, sfAccounts);

  // Step 4: Check ownership in batches of 15
  const BATCH_SIZE = 15;
  const withOwnership: DiscoveredCompany[] = [];
  for (let i = 0; i < afterDedup.length; i += BATCH_SIZE) {
    const batch = afterDedup.slice(i, i + BATCH_SIZE);
    const checked = await checkOwnershipBatch(client, batch);
    withOwnership.push(...checked);
  }

  return {
    companies: withOwnership,
    stats: {
      searched: CDM_VERTICALS.length,
      found: allFound.length,
      deduped: allFound.length - afterDedup.length,
      filteredByGeo: allFound.length - afterGeo.length,
      final: withOwnership.length,
    },
  };
}
