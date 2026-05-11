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
  extractOutreachParagraph,
  personalizeOutreach,
  findGroupFileName,
} from "@/lib/scout";

export type SourcingResult = {
  url: string;
  currentText: string;
  products: string[];
  foundingYear: number | null;
  portfolioMatch: {
    matched: boolean;
    group: string | null;
    confidence?: number | null;
  };
  archiveUrl: string | null;
  archiveYear: string | null;
  wbLabel: string;
  oldProducts: string[];
  discontinued: string | null;
  discontinuedNote: string | null;
  address: string | null;
  restaurants: { name: string; description: string }[];
  outreachParagraph: string | null;
  competitors: { name: string; differentiator: string }[];
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
    logs.push(`Best match: ${portfolioMatch.group}${conf}`);
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
  const candidates = await getWaybackCandidates(normalized, wbFrom, wbTo);

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
  const [address, outreachParagraph] = await Promise.all([
    extractAddress(anthropic, currentText, normalized),
    generateOutreach(
      anthropic,
      normalized,
      currentText,
      products,
      portfolioMatch.group,
      outreachLogs,
    ),
  ]);
  if (address) logs.push(`Address found: ${address}`);
  else logs.push("Company address not found.");
  logs.push(...outreachLogs);

  let restaurants: { name: string; description: string }[] = [];
  if (address) {
    logs.push(`Searching for business dinner restaurants near ${address}...`);
    restaurants = await findRestaurants(anthropic, address);
    if (restaurants.length > 0) {
      logs.push(`Found ${restaurants.length} restaurant recommendation(s).`);
    }
  }

  // Competitor identification skipped (UI section removed). Keeping the
  // field on the result shape so older jobs in Supabase still render.
  const competitors: { name: string; differentiator: string }[] = [];
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
    oldProducts,
    discontinued,
    discontinuedNote,
    address,
    restaurants,
    outreachParagraph,
    competitors,
    logs,
  };
}
