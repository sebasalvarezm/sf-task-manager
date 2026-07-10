import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  scrapeWithJina,
  isParkedPage,
  extractProducts,
  extractCopyrightYear,
  detectFoundingYear,
  getEarliestSnapshotYear,
  searchFoundingYearWeb,
  loadGroupFiles,
  matchGroup,
  getWaybackCandidates,
  getInteriorCandidates,
  fetchWaybackSnapshot,
  extractNewsProducts,
  findDiscontinued,
  extractAddress,
  findRestaurants,
  quickCompanyName,
  extractOutreachParagraph,
  personalizeOutreach,
  generateEmailHook,
  researchCompanyAnchors,
  findGroupFileName,
  type WaybackStatus,
  type CompanyAnchor,
} from "@/lib/scout";
import {
  buildPrepackagedEmail,
  type PrepackagedEmail,
} from "@/lib/email-prepackage";

export type SourcingResult = {
  url: string;
  currentText: string;
  products: string[];
  foundingYear: number | null;
  portfolioMatch: {
    matched: boolean;
    group: string | null;
    /** Main industry group folder, e.g. "Manufacturing" */
    mainGroup?: string | null;
    confidence?: number | null;
  };
  archiveUrl: string | null;
  archiveYear: string | null;
  wbLabel: string;
  waybackStatus: WaybackStatus | null;
  oldProducts: string[];
  discontinued: string | null;
  discontinuedNote: string | null;
  address: string | null;
  addressSource: string | null;
  addressSourceUrl: string | null;
  locationConfidence: "exact" | "city" | "none";
  restaurants: { name: string; description: string }[];
  outreachParagraph: string | null;
  emailHook: string | null;
  competitors: { name: string; differentiator: string }[];
  prepackagedEmail?: PrepackagedEmail | null;
  logs: string[];
};

function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(item.trim());
    }
  }
  return result;
}

async function identifyCompetitors(
  client: Anthropic,
  currentText: string,
  products: string[],
): Promise<{ name: string; differentiator: string }[]> {
  const productList = products.length > 0 ? products.join(", ") : "unknown";
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Based on this company's website content, identify 2-3 key competitors or similar companies in their space.

COMPANY WEBSITE (excerpt):
${currentText.slice(0, 4000)}

PRODUCTS/SERVICES: ${productList}

Return a JSON array only (no markdown, no explanation):
[{"name":"Competitor Name","differentiator":"One sentence on how they differ or compete"}]

If you can't identify competitors with reasonable confidence, return [].`,
        },
      ],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text : "";
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      name: string;
      differentiator: string;
    }[];
    return (parsed ?? []).slice(0, 3);
  } catch {
    return [];
  }
}

async function generateOutreach(
  client: Anthropic,
  url: string,
  currentText: string,
  products: string[],
  portfolioGroup: string | null,
  logs: string[],
): Promise<string | null> {
  if (!portfolioGroup) return null;
  logs.push("Drafting outreach paragraph...");
  const groups = loadGroupFiles();
  const fileName = findGroupFileName(portfolioGroup, groups);
  if (!fileName || !(fileName in groups)) {
    logs.push("Could not find group file for outreach template.");
    return null;
  }
  const baseOutreach = extractOutreachParagraph(groups[fileName]);
  if (!baseOutreach) {
    logs.push("No outreach template found in group file.");
    return null;
  }
  const result = await personalizeOutreach(
    client,
    baseOutreach,
    url,
    currentText,
    products,
  );
  logs.push("Outreach paragraph complete.");
  return result;
}

export async function runFullSourcing(input: {
  url: string;
  onProgress?: (step: string, pct: number) => void;
}): Promise<SourcingResult> {
  const { url, onProgress } = input;
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    throw new Error("AI service not configured (missing ANTHROPIC_API_KEY)");
  }

  const normalized = url.startsWith("http") ? url : `https://${url}`;
  const logs: string[] = [];

  // ───────── Stage 1: Scrape current site ─────────
  onProgress?.("scrape", 5);
  logs.push("Scraping current website...");
  const currentText = await scrapeWithJina(normalized);
  if (!currentText || currentText.length < 100) {
    throw new Error(
      "Could not extract any text from this site. It may require a login, block scrapers, or be JavaScript-only.",
    );
  }
  if (isParkedPage(currentText)) {
    throw new Error("This domain appears to be parked or a placeholder page.");
  }
  logs.push(`Extracted ${currentText.length.toLocaleString()} characters.`);
  onProgress?.("scrape", 15);

  // Parallel: products / copyrightYear / claudeYear / wayback earliest / groups
  logs.push("Extracting current products and services...");
  const [products, copyrightYear, claudeYear, waybackYear, groups] =
    await Promise.all([
      extractProducts(anthropic, currentText, "current"),
      Promise.resolve(extractCopyrightYear(currentText)),
      detectFoundingYear(anthropic, currentText),
      getEarliestSnapshotYear(normalized),
      Promise.resolve(loadGroupFiles()),
    ]);

  if (products.length > 0) {
    const preview = products.slice(0, 5).join(", ");
    const suffix = products.length > 5 ? "..." : "";
    logs.push(`Found ${products.length} product(s): ${preview}${suffix}`);
  } else {
    logs.push("No named products/services found on the current site.");
  }

  // Determine founding year — take minimum of available signals
  const yearCandidates: { source: string; year: number }[] = [];
  if (copyrightYear) yearCandidates.push({ source: "copyright footer", year: copyrightYear });
  if (claudeYear) yearCandidates.push({ source: "page text", year: claudeYear });
  if (waybackYear) yearCandidates.push({ source: "earliest web archive", year: waybackYear });

  let foundingYear: number | null = null;
  if (yearCandidates.length > 0) {
    const best = yearCandidates.reduce((a, b) => (a.year < b.year ? a : b));
    foundingYear = best.year;
    logs.push(`Founding year: ${best.year} (from ${best.source})`);
  } else {
    logs.push("No founding year from page — searching the web...");
    const webYear = await searchFoundingYearWeb(anthropic, normalized);
    if (webYear) {
      foundingYear = webYear;
      logs.push(`Founding year: ${webYear} (from web search)`);
    } else {
      logs.push("Founding year not found — using wide Wayback window.");
    }
  }
  onProgress?.("scrape", 25);

  // Portfolio match
  logs.push(`Loaded ${Object.keys(groups).length} portfolio group file(s).`);
  logs.push("Matching to portfolio group...");
  const portfolioMatch = await matchGroup(anthropic, currentText, groups);
  if (portfolioMatch.matched) {
    const conf = portfolioMatch.confidence != null
      ? ` (${portfolioMatch.confidence}% confidence)`
      : "";
    const groupLabel = portfolioMatch.mainGroup
      ? `${portfolioMatch.mainGroup} → ${portfolioMatch.group}`
      : portfolioMatch.group;
    logs.push(`Best match: ${groupLabel}${conf}`);
  } else {
    logs.push("No portfolio group is a strong fit for this company.");
  }
  onProgress?.("history", 30);

  // ───────── Stage 2: Wayback history ─────────
  let wbFrom: string;
  let wbTo: string;
  let wbLabel: string;
  if (foundingYear && foundingYear >= 2010) {
    wbFrom = `${foundingYear}0101`;
    wbTo = `${foundingYear + 5}1231`;
    wbLabel = `${foundingYear}–${foundingYear + 5}`;
  } else if (foundingYear) {
    wbFrom = "20050101";
    wbTo = "20151231";
    wbLabel = "2005–2015";
  } else {
    wbFrom = "20060101";
    wbTo = "20201231";
    wbLabel = "2006–2020";
  }

  logs.push(`Fetching Wayback Machine snapshots from ${wbLabel}...`);
  const { candidates, status: waybackStatus } = await getWaybackCandidates(
    normalized,
    wbFrom,
    wbTo,
  );

  if (waybackStatus === "fallback_used") {
    logs.push(
      "Wayback CDX returned nothing — using Availability API fallback snapshot.",
    );
  } else if (waybackStatus === "timeout") {
    logs.push(
      "Wayback Machine timed out (Wayback-side issue, not the company).",
    );
  } else if (waybackStatus === "http_error" || waybackStatus === "network_error") {
    logs.push(`Wayback Machine unreachable (${waybackStatus}).`);
  } else if (waybackStatus === "empty") {
    logs.push("Wayback Machine has no archived snapshots in that window.");
  }

  let archiveUrl: string | null = null;
  let archiveTimestamp: string | null = null;
  const allOldProducts: string[] = [];

  if (candidates.length > 0) {
    logs.push(`Found ${candidates.length} candidate snapshot(s).`);
    const parsed = new URL(normalized);
    const domainStem = parsed.hostname
      .replace("www.", "")
      .split(".")[0]
      .toLowerCase();
    const domainOnly = parsed.hostname.replace("www.", "");

    let validCount = 0;
    for (const candidate of candidates) {
      if (validCount >= 3) break;
      const year = candidate.timestamp.slice(0, 4);
      const result = await fetchWaybackSnapshot(candidate.url, domainStem);
      if (result.skipReason) {
        logs.push(`Skipping ${year} snapshot — ${result.skipReason}.`);
        continue;
      }
      if (result.text) {
        if (!archiveUrl) {
          archiveUrl = candidate.url;
          archiveTimestamp = candidate.timestamp;
        }
        logs.push(`Valid snapshot found from ${year}.`);
        const ps = await extractProducts(
          anthropic,
          result.text,
          `archived (${year})`,
        );
        if (ps.length > 0) allOldProducts.push(...ps);
        validCount++;
      }
    }

    // Probe interior product/solution/services pages
    const interiorKeywords = [
      "product",
      "solution",
      "service",
      "platform",
      "software",
    ];
    let interiorChecked = 0;
    for (const keyword of interiorKeywords) {
      if (interiorChecked >= 3) break;
      const ics = await getInteriorCandidates(
        domainOnly,
        keyword,
        wbFrom,
        wbTo,
        1,
      );
      for (const ic of ics) {
        if (interiorChecked >= 3) break;
        const r = await fetchWaybackSnapshot(ic.url, domainStem);
        if (r.skipReason || !r.text) continue;
        const icYear = ic.timestamp.slice(0, 4);
        logs.push(`Interior page snapshot (/${keyword}*, ${icYear}).`);
        const icProducts = await extractProducts(
          anthropic,
          r.text,
          `archived (${icYear}) interior`,
        );
        if (icProducts.length > 0) allOldProducts.push(...icProducts);
        interiorChecked++;
        break;
      }
    }

    // Fallback: news/press/blog
    if (allOldProducts.length < 3 && archiveUrl) {
      const newsKeywords = [
        "news",
        "press",
        "blog",
        "media",
        "announcements",
      ];
      let newsChecked = 0;
      for (const keyword of newsKeywords) {
        if (newsChecked >= 2) break;
        const ncs = await getInteriorCandidates(
          domainOnly,
          keyword,
          wbFrom,
          wbTo,
          1,
        );
        for (const nc of ncs) {
          if (newsChecked >= 2) break;
          const r = await fetchWaybackSnapshot(nc.url, domainStem);
          if (r.skipReason || !r.text) continue;
          const ncYear = nc.timestamp.slice(0, 4);
          logs.push(`News page snapshot (/${keyword}*, ${ncYear}).`);
          const ncProducts = await extractNewsProducts(
            anthropic,
            r.text,
            ncYear,
          );
          if (ncProducts.length > 0) allOldProducts.push(...ncProducts);
          newsChecked++;
          break;
        }
      }
    }
  }

  const archiveYear = archiveTimestamp ? archiveTimestamp.slice(0, 4) : null;
  const oldProducts = dedup(allOldProducts);
  if (oldProducts.length > 0) {
    logs.push(`Total unique archived products: ${oldProducts.length}.`);
  } else {
    logs.push("No archived products found.");
  }

  let discontinued: string | null = null;
  let discontinuedNote: string | null = null;
  if (oldProducts.length > 0 && products.length > 0) {
    discontinued = await findDiscontinued(
      anthropic,
      oldProducts,
      products,
      wbLabel,
    );
    if (discontinued) {
      discontinuedNote = `Found on the ${archiveYear} archived version (Wayback Machine, ${wbLabel} window).`;
      logs.push(`Discontinued item: ${discontinued}`);
    } else {
      logs.push("No discontinued items identified.");
    }
  }
  onProgress?.("details", 70);

  // ───────── Stage 3: Address + outreach + competitors + restaurants ─────────
  logs.push("Finding company address...");
  const outreachLogs: string[] = [];
  const sourceCompanyName = quickCompanyName(normalized);
  const [addressInfo, outreachParagraph] = await Promise.all([
    extractAddress(anthropic, currentText, normalized, sourceCompanyName),
    generateOutreach(
      anthropic,
      normalized,
      currentText,
      products,
      portfolioMatch.group,
      outreachLogs,
    ),
  ]);
  let address = addressInfo.address;
  let addressSource = addressInfo.source;
  let addressSourceUrl = addressInfo.sourceUrl;
  let locationConfidence = addressInfo.confidence;
  if (address) {
    const via =
      addressInfo.source === "company website"
        ? "from the website"
        : addressInfo.source === "web search (company name)"
          ? "via web search by company name"
          : "via web search";
    logs.push(`Address found (${via}): ${address}`);
  } else {
    logs.push(
      "Company address not found yet — the restaurant search will also try to locate the city.",
    );
  }
  logs.push(...outreachLogs);

  // Always attempt a restaurant search — pass the company name so it can find
  // a city even when no address was resolved.
  logs.push("Searching for business dinner restaurants...");
  const restaurantResult = await findRestaurants(
    anthropic,
    address,
    sourceCompanyName,
  );
  const restaurants = restaurantResult.restaurants;
  if (restaurants.length > 0) {
    logs.push(`Found ${restaurants.length} restaurant recommendation(s).`);
  } else {
    logs.push("Could not retrieve restaurant recommendations.");
  }

  // Address rescue: if address extraction failed but the restaurant search
  // located the company's city, keep that city as the location so the result
  // always shows at least "City, ST".
  if (!address && restaurantResult.city) {
    address = restaurantResult.city;
    addressSource = "web search (restaurant lookup)";
    addressSourceUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      restaurantResult.city,
    )}`;
    locationConfidence = "city";
    logs.push(`City located via restaurant search: ${address}`);
  } else if (!address) {
    logs.push("Company location not found — even after all web searches.");
  }

  // Competitor identification skipped (UI section removed). Keeping the
  // field on the result shape so older jobs in Supabase still render.
  const competitors: { name: string; differentiator: string }[] = [];

  // ───────── Stage 4: Email opening hook ─────────
  logs.push("Researching company anchors for hook...");
  let companyName = "";
  let anchors: CompanyAnchor[] = [];
  try {
    const r = await researchCompanyAnchors(
      anthropic,
      normalized,
      currentText,
      products,
      oldProducts,
      discontinued,
      archiveYear,
    );
    companyName = r.companyName;
    anchors = r.anchors;
    logs.push(`Found ${anchors.length} candidate anchor(s).`);
  } catch (err) {
    logs.push(
      `Anchor research failed: ${err instanceof Error ? err.message : "unknown error"}.`,
    );
  }

  logs.push("Generating email opening hook...");
  let emailHook: string | null = null;
  try {
    let matchedGroupContent = "";
    if (portfolioMatch.matched && portfolioMatch.group) {
      const fileName = findGroupFileName(portfolioMatch.group, groups);
      if (fileName && fileName in groups) {
        matchedGroupContent = groups[fileName];
      }
    }
    emailHook = await generateEmailHook(
      anthropic,
      companyName,
      normalized,
      currentText,
      products,
      foundingYear,
      oldProducts,
      discontinued,
      archiveYear,
      anchors,
      matchedGroupContent,
    );
    logs.push("Email hook complete.");
  } catch (err) {
    logs.push(
      `Hook generation failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  // ───────── Stage 5: Prepackage Email 1 ─────────
  // Plain string swaps into the matched subgroup's template — no AI call.
  const prepackagedEmail = buildPrepackagedEmail({
    mainGroup: portfolioMatch.mainGroup,
    subgroup: portfolioMatch.group,
    emailHook,
    outreachParagraph,
    address,
    locationConfidence,
    restaurants,
    now: new Date(),
  });
  if (prepackagedEmail.skipped) {
    logs.push(`Prepackaged email skipped: ${prepackagedEmail.skipReason}`);
  } else {
    logs.push(`Prepackaged Email 1 built from "${prepackagedEmail.templateSubgroup}".`);
    for (const w of prepackagedEmail.warnings) logs.push(`Prepackage note: ${w}`);
  }

  onProgress?.("details", 100);

  return {
    url: normalized,
    currentText,
    products,
    foundingYear,
    portfolioMatch,
    archiveUrl,
    archiveYear,
    wbLabel,
    waybackStatus,
    oldProducts,
    discontinued,
    discontinuedNote,
    address,
    addressSource,
    addressSourceUrl,
    locationConfidence,
    restaurants,
    outreachParagraph,
    emailHook,
    competitors,
    prepackagedEmail,
    logs,
  };
}
