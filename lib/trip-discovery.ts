import Anthropic from "@anthropic-ai/sdk";
import { CDMAccount } from "./salesforce-trip";
import {
  geocodeAddress,
  haversineDistance,
  getDrivingDistances,
} from "./geocoding";

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
  // Set after geocoding + distance computation
  lat: number | null;
  lng: number | null;
  straightLineMiles: number | null;
  distanceMiles: number | null;
  durationMinutes: number | null;
  durationText: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WEB_SEARCH_TOOL: any[] = [
  { type: "web_search_20250305", name: "web_search", max_uses: 4 },
];

function extractLastText(content: Anthropic.Messages.ContentBlock[]): string {
  const textBlocks = content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  if (textBlocks.length === 0) return "";
  return textBlocks[textBlocks.length - 1].text.trim();
}

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
      max_tokens: 4096,
      tools: WEB_SEARCH_TOOL,
      messages: [
        {
          role: "user",
          content: `Use web search to find software companies within roughly ${radiusMiles} driving miles of ${location} that serve the ${vertical.name} industry. Real, verified, currently-operating companies — not speculation. Use the web_search tool to look them up; do not rely solely on prior knowledge.

**CRITICAL GEOGRAPHIC CONSTRAINT:**
Every company MUST be physically headquartered within ${radiusMiles} miles of ${location}. Do NOT include companies in other states, provinces, or regions, even if they would otherwise fit the profile. The user's location may be in any country (USA, Canada, etc.) — respect that. When in doubt, exclude.

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

    const text = extractLastText(resp.content);
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
      lat: null,
      lng: null,
      straightLineMiles: null,
      distanceMiles: null,
      durationMinutes: null,
      durationText: null,
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
      max_tokens: 4096,
      tools: WEB_SEARCH_TOOL,
      messages: [
        {
          role: "user",
          content: `Use web search to determine the current ownership status of each company below. Search recent news (last 5 years) for each: "[Company name] acquired", "[Company name] portfolio", "[Company name] private equity". Acquisition status changes over time, so prior knowledge alone is unreliable — always verify with web search.

Categories:
- "independent" = privately held, founder/family-owned, no PE/VC backing, never acquired
- "pe_vc" = currently backed by private equity, venture capital, or a holding company that isn't a software aggregator (e.g., Vista Equity, Thoma Bravo, KKR, family offices, growth funds)
- "aggregator" = acquired by a buy-and-hold software aggregator

Known software aggregators to check against (any acquisition by these = "aggregator"): ${aggregatorList}

If a company has been acquired by ANY entity in the last 5 years, it is NOT independent. Bias toward marking as pe_vc or aggregator when there's evidence of an acquisition.

Companies:
${companyList}

Return a JSON array with one entry per company (same order). Return ONLY the JSON, no markdown:
[{"index":0,"ownership":"independent","detail":null},{"index":1,"ownership":"aggregator","detail":"Acquired by Volaris Group (Constellation Software) in 2022"}]

"detail" is a short note (1 sentence) when ownership is "pe_vc" or "aggregator" — name the parent + year if known.`,
        },
      ],
    });

    const text = extractLastText(resp.content);
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

// ── Geocoding-based distance filter ─────────────────────────────────────────
// Replaces the old US state-adjacency filter (which broke for Canadian and
// non-US locations). Geocodes each company's claimed city/state, computes
// haversine distance to the user, and keeps only those within radius.

async function filterByDistance(
  companies: DiscoveredCompany[],
  userLat: number,
  userLng: number,
  radiusMiles: number,
): Promise<DiscoveredCompany[]> {
  const enriched = await Promise.all(
    companies.map(async (c) => {
      if (!c.city) return null; // can't verify location → drop (was: kept)
      const addr = c.state ? `${c.city}, ${c.state}` : c.city;
      const geo = await geocodeAddress(addr);
      if (!geo) return null;
      const dist = haversineDistance(userLat, userLng, geo.lat, geo.lng);
      if (dist > radiusMiles) return null;
      return {
        ...c,
        lat: geo.lat,
        lng: geo.lng,
        straightLineMiles: Math.round(dist),
      };
    }),
  );
  return enriched.filter((c) => c !== null) as DiscoveredCompany[];
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
  userGeo: { lat: number; lng: number },
  radiusMiles: number,
  sfAccounts: CDMAccount[],
): Promise<{
  companies: DiscoveredCompany[];
  stats: {
    searched: number;
    found: number;
    deduped: number;
    filteredByGeo: number;
    final: number;
  };
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Step 1: Search all 9 verticals in parallel (with web search grounding)
  const verticalResults = await Promise.all(
    CDM_VERTICALS.map((v) => searchVertical(client, v, location, radiusMiles)),
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

  // Step 2: Real geocoding-based distance filter (replaces state-adjacency)
  const afterGeo = await filterByDistance(
    allFound,
    userGeo.lat,
    userGeo.lng,
    radiusMiles,
  );

  // Step 3: Remove companies already in Salesforce
  const afterDedup = deduplicateAgainstSF(afterGeo, sfAccounts);

  // Step 4: Check ownership in batches of 15 (with web search)
  const BATCH_SIZE = 15;
  const withOwnership: DiscoveredCompany[] = [];
  for (let i = 0; i < afterDedup.length; i += BATCH_SIZE) {
    const batch = afterDedup.slice(i, i + BATCH_SIZE);
    const checked = await checkOwnershipBatch(client, batch);
    withOwnership.push(...checked);
  }

  // Step 5: Driving distances (only for companies with lat/lng)
  const withCoords = withOwnership.filter(
    (c): c is DiscoveredCompany & { lat: number; lng: number } =>
      c.lat != null && c.lng != null,
  );
  if (withCoords.length > 0) {
    const distResults = await getDrivingDistances(
      { lat: userGeo.lat, lng: userGeo.lng },
      withCoords.map((c, i) => ({ id: String(i), lat: c.lat, lng: c.lng })),
    );
    const distMap = new Map(distResults.map((d) => [d.id, d]));
    withCoords.forEach((c, i) => {
      const d = distMap.get(String(i));
      if (d) {
        c.distanceMiles = d.distanceMiles;
        c.durationMinutes = d.durationMinutes;
        c.durationText = d.durationText;
      }
    });
  }

  // Step 6: Sort by driving time ascending (failures last)
  withOwnership.sort(
    (a, b) =>
      (a.durationMinutes ?? Number.MAX_SAFE_INTEGER) -
      (b.durationMinutes ?? Number.MAX_SAFE_INTEGER),
  );

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
