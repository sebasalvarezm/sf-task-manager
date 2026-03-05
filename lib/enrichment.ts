import { getAnthropicClient } from "./anthropic";

// What enrichment returns to the frontend
export type EnrichedCompanyData = {
  companyName: string | null;
  website: string;
  yearEstablished: string | null;
  employees: number | null;
  industry: string | null;
  country: string | null;
  stateProvince: string | null;
  confidence: "high" | "medium" | "low";
};

const EMPTY_RESULT = (website: string): EnrichedCompanyData => ({
  companyName: null,
  website,
  yearEstablished: null,
  employees: null,
  industry: null,
  country: null,
  stateProvince: null,
  confidence: "low",
});

// ── Website scraping via Jina AI Reader (best-effort) ────────────────────────

async function fetchPageText(url: string, timeoutMs = 10000): Promise<string | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/plain" },
    });
    const text = await res.text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function fetchMultiplePages(baseUrl: string): Promise<string> {
  const normalized = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const base = normalized.replace(/\/+$/, "");

  const pages = [
    base,
    base + "/about",
    base + "/about-us",
    base + "/contact",
    base + "/company",
  ];

  const results: string[] = [];
  let totalChars = 0;
  const MAX_CHARS = 10000;

  for (const pageUrl of pages) {
    if (totalChars >= MAX_CHARS) break;
    const text = await fetchPageText(pageUrl, 8000);
    if (text && text.length > 100) {
      const trimmed = text.slice(0, MAX_CHARS - totalChars);
      results.push(`--- Page: ${pageUrl} ---\n${trimmed}`);
      totalChars += trimmed.length;
    }
  }

  return results.join("\n\n");
}

// ── JSON extraction helper ────────────────────────────────────────────────────

function parseEnrichmentJson(
  raw: string,
  website: string
): EnrichedCompanyData {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);
  return {
    companyName: parsed.companyName || null,
    website,
    yearEstablished: parsed.yearEstablished || null,
    employees: typeof parsed.employees === "number" ? parsed.employees : null,
    industry: parsed.industry || null,
    country: parsed.country || null,
    stateProvince: parsed.stateProvince || null,
    confidence: parsed.confidence || "medium",
  };
}

// ── Main enrichment function ─────────────────────────────────────────────────

export async function enrichCompany(url: string): Promise<EnrichedCompanyData> {
  const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;

  // Step 1: Try Jina scraping (free, fast — may fail if site blocks scrapers)
  const scrapedText = await fetchMultiplePages(normalizedUrl);
  const hasScrapedContent = scrapedText.length > 100;

  // Step 2: Call Claude — with web search enabled as fallback
  const anthropic = getAnthropicClient();
  if (!anthropic) return EMPTY_RESULT(normalizedUrl);

  const extractionPrompt = `Extract company information for the company at: ${normalizedUrl}

${
  hasScrapedContent
    ? `Scraped website content:\n${scrapedText.slice(0, 6000)}\n\nIf the scraped content is missing key fields, use web search to supplement.`
    : `The website could not be scraped (likely blocked). Use web search to find information about this company from LinkedIn, Crunchbase, company directories, or other public sources.`
}

Return ONLY valid JSON with these fields (no explanation, no markdown, just JSON):
{
  "companyName": "The commonly-used short public name only (e.g. 'DOP Software', NOT 'DOP Software (Dynamic Operating Program)'). Never include parenthetical acronym expansions or legal suffixes unless they are part of the everyday brand name. Return null if unknown.",
  "yearEstablished": "4-digit year as string e.g. '2005' or null",
  "employees": approximate employee count as number or null,
  "industry": "Pick the EXACT value from Salesforce's standard picklist: Agriculture, Apparel, Banking, Biotechnology, Chemicals, Communications, Construction, Consulting, Education, Electronics, Energy, Engineering, Entertainment, Environmental, Finance, Food & Beverage, Government, Healthcare, Hospitality, Insurance, Machinery, Manufacturing, Media, Not For Profit, Recreation, Retail, Shipping, Technology, Telecommunications, Transportation, Utilities, Other — or null if none fit",
  "country": "Country name e.g. 'United States' or null",
  "stateProvince": "Full official name of US state or Canadian province only (e.g. 'California', 'Ontario'). Return null if outside US/Canada or unknown.",
  "confidence": "high" if 4+ fields found, "medium" if 2-3 fields, "low" if fewer
}`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ];

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools,
      messages: [{ role: "user", content: extractionPrompt }],
    });

    // Find the last text block — web search responses contain multiple content blocks
    // (web_search_result blocks interleaved with text). The final text block has the JSON.
    const textBlocks = message.content.filter((b) => b.type === "text");
    if (textBlocks.length === 0) return EMPTY_RESULT(normalizedUrl);

    const lastText = textBlocks[textBlocks.length - 1];
    const responseText = lastText.type === "text" ? lastText.text.trim() : "";
    if (!responseText) return EMPTY_RESULT(normalizedUrl);

    return parseEnrichmentJson(responseText, normalizedUrl);
  } catch {
    return EMPTY_RESULT(normalizedUrl);
  }
}
