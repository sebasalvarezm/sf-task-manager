/**
 * scout.ts — Company research engine for the Sourcing Tool.
 *
 * Ported from the Python scout.py. Uses Jina AI Reader for web scraping
 * and Claude AI for analysis. Replaces BeautifulSoup + DuckDuckGo with
 * Jina Reader + Claude web_search.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Text signals that indicate a parked, placeholder, or unrelated domain page */
const PARKING_SIGNALS = [
  "domain for sale",
  "buy this domain",
  "parked by",
  "1&1 internet",
  "1and1",
  "namecheap",
  "register.com",
  "sedo.com",
  "godaddy",
  "this domain has been registered",
  "under construction",
  "free website builder",
  "web hosting provider",
  "this web page is parked",
  "domain parking",
  "domain registrar",
];

/**
 * Headers sent with every Wayback Machine CDX / Availability API call.
 * Wayback throttles and silently drops unidentified traffic — using a
 * descriptive User-Agent dramatically improves reliability.
 */
const WAYBACK_HEADERS: Record<string, string> = {
  "User-Agent":
    "ValstoneScout/1.0 (M&A research tool; contact: sebastian@valstonecorp.com)",
  Accept: "application/json",
};

/** Sub-pages to crawl after the homepage for richer product coverage */
const CRAWL_PATHS = [
  "/about",
  "/about-us",
  "/products",
  "/solutions",
  "/services",
  "/features",
  "/platform",
  "/software",
  "/company",
  "/location",
  "/locations",
  "/offices",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScrapeResult = {
  currentText: string;
  products: string[];
  foundingYear: number | null;
  portfolioMatch: {
    matched: boolean;
    group: string | null;
    mainGroup?: string | null;
  };
};

export type HistoryResult = {
  archiveUrl: string | null;
  archiveYear: string | null;
  wbLabel: string;
  discontinued: string | null;
  discontinuedNote: string | null;
  oldProducts: string[];
};

export type DetailsResult = {
  address: string | null;
  restaurants: { name: string; description: string }[];
  outreachParagraph: string | null;
};

// ---------------------------------------------------------------------------
// Helpers: Jina AI Reader (web scraping)
// ---------------------------------------------------------------------------

/**
 * Fetch a single page's text content via Jina AI Reader.
 * Jina renders the page like a browser and returns clean readable text.
 * Best for live/modern websites. Do NOT use for Wayback Machine URLs.
 */
async function fetchPageText(
  url: string,
  timeoutMs = 10000
): Promise<string | null> {
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

/**
 * Fetch a page's text by direct HTTP request + HTML tag stripping.
 * Used for Wayback Machine archived pages where Jina Reader doesn't work.
 * Mirrors the Python version's requests.get() + BeautifulSoup approach.
 */
async function fetchRawText(
  url: string,
  timeoutMs = 20000,
  maxChars = 8000
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    let html = await res.text();
    // Remove Wayback Machine toolbar (injected into every archived page)
    // Marked by HTML comments or specific div IDs
    html = html.replace(
      /<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi,
      ""
    );
    html = html.replace(
      /<div[^>]*id=["']wm-ipp(?:-[a-z]*)?["'][\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi,
      ""
    );
    // Also remove the Wayback Machine's injected FILE comment block
    html = html.replace(
      /<!--\s*playback timance\s*-->[\s\S]*?<!--\s*End Wayback Rewrite JS Include\s*-->/gi,
      ""
    );
    // Remove script, style, nav, footer, header, aside blocks
    html = html.replace(
      /<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    );
    // Remove all remaining HTML tags
    html = html.replace(/<[^>]+>/g, " ");
    // Decode common HTML entities
    html = html
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#?\w+;/g, " ");
    // Collapse whitespace and strip non-printable characters
    const text = html
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
    return text.slice(0, maxChars) || null;
  } catch {
    return null;
  }
}

/**
 * Scrape a company website — homepage + key sub-pages.
 * Returns combined text (capped at maxTotalChars).
 */
export async function scrapeWithJina(
  baseUrl: string,
  maxTotalChars = 12000
): Promise<string> {
  const normalized = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const base = normalized.replace(/\/+$/, "");

  // Try homepage first
  let homepageText = await fetchPageText(base, 12000);

  // If homepage fails, try www / non-www variant
  if (!homepageText || homepageText.length < 300) {
    const url = new URL(base);
    const altHost = url.hostname.startsWith("www.")
      ? url.hostname.slice(4)
      : `www.${url.hostname}`;
    const altBase = `${url.protocol}//${altHost}${url.pathname}`.replace(
      /\/+$/,
      ""
    );
    homepageText = await fetchPageText(altBase, 12000);
  }

  if (!homepageText || homepageText.length < 300) {
    return "";
  }

  const collected: string[] = [homepageText];
  let total = homepageText.length;

  // Crawl sub-pages for richer product/service coverage
  for (const p of CRAWL_PATHS) {
    if (total >= maxTotalChars) break;
    const text = await fetchPageText(base + p, 8000);
    if (text && text.length > 200) {
      const trimmed = text.slice(0, maxTotalChars - total);
      collected.push(trimmed);
      total += trimmed.length;
    }
  }

  return collected.join("\n\n").slice(0, maxTotalChars);
}

/** Check if page text looks like a domain parking / placeholder page. */
export function isParkedPage(text: string): boolean {
  const lower = text.toLowerCase();
  return PARKING_SIGNALS.some((signal) => lower.includes(signal));
}

// ---------------------------------------------------------------------------
// Helpers: Claude AI calls
// ---------------------------------------------------------------------------

/**
 * Wrapper around Claude messages.create() with automatic retry on transient errors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callClaude(client: Anthropic, maxRetries = 2, opts: any): Promise<any> {
  const RETRYABLE = [500, 503, 529];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(opts);
    } catch (err) {
      if (
        err instanceof Anthropic.APIError &&
        RETRYABLE.includes(err.status) &&
        attempt < maxRetries
      ) {
        const wait = 2000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Product Extraction
// ---------------------------------------------------------------------------

/**
 * Ask Claude to extract product and service names from page text.
 * Uses a stricter prompt for archived pages (branded names only).
 */
export async function extractProducts(
  client: Anthropic,
  text: string,
  label: string
): Promise<string[]> {
  if (!text) return [];

  const isArchived = label.toLowerCase().includes("archived");

  const archiveHint = isArchived
    ? `\nIMPORTANT: This text is from a web archive (Wayback Machine). Ignore any text related to 'Wayback Machine', 'archive.org', 'Internet Archive', web archive navigation, timestamps, or website metadata. Focus ONLY on the company's actual products and services.\n`
    : "";

  const prompt = `Extract every distinct product name and service name from this ${label} website text.
Include branded products, named service lines, software platforms, and specific offerings.${archiveHint}
Return a JSON array of strings only. No commentary, no explanation.
If you find nothing, return an empty array: []

Text:
${text.slice(0, 6000)}`;

  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.content[0].text.trim();
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // Parse failure — return empty
  }
  return [];
}

/**
 * Extract product names from news/press release pages.
 * Uses a prompt tailored to press releases and product launch announcements
 * rather than product listing pages.
 */
export async function extractNewsProducts(
  client: Anthropic,
  text: string,
  year: string
): Promise<string[]> {
  if (!text) return [];

  const prompt = `This text is from an archived news/press/blog page (circa ${year}) of a company website.
IMPORTANT: Ignore any text related to 'Wayback Machine', 'archive.org', 'Internet Archive', web archive navigation, or website metadata.

Extract the names of any products, services, software platforms, or technologies that are mentioned as being launched, released, announced, or acquired. Look for patterns like:
- "We are pleased to announce [Product Name]"
- "Company has released [Product Name]"
- "Introducing [Product Name]"
- "New [Product Name] now available"
- "[Product Name] launch" or "[Product Name] release"

Return a JSON array of product/service names only. No commentary, no explanation.
If you find nothing, return an empty array: []

Text:
${text.slice(0, 6000)}`;

  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.content[0].text.trim();
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // Parse failure — return empty
  }
  return [];
}

// ---------------------------------------------------------------------------
// Founding Year Detection
// ---------------------------------------------------------------------------

/**
 * Extract copyright year from page text using regex.
 * Only returns years at least 2 years old (current-year notices are not founding dates).
 */
export function extractCopyrightYear(text: string): number | null {
  if (!text) return null;
  const pattern = /(?:©|&copy;|\(c\)|copyright)[^0-9]{0,10}(\d{4})/gi;
  const matches: number[] = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    matches.push(parseInt(m[1]));
  }
  const currentYear = new Date().getFullYear();
  const historical = matches.filter((y) => y >= 1990 && y <= currentYear - 2);
  return historical.length > 0 ? Math.min(...historical) : null;
}

/**
 * Ask Claude to extract the company's founding year from website text.
 */
export async function detectFoundingYear(
  client: Anthropic,
  text: string
): Promise<number | null> {
  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: `What year was this company founded? Look for clues like 'founded in', 'established', 'since XXXX', or founding stories in 'About Us' sections.

Important: do NOT return years from the last 2 years — those are almost always recent site content (news, certifications, awards), not founding dates. If the only year clues you find are recent, return null instead.

Return only the 4-digit year as a plain number (e.g. 2014). If you cannot determine it with reasonable confidence, return null.

Text:
${text.slice(0, 4000)}`,
      },
    ],
  });

  const raw = resp.content[0].text.trim();
  const match = raw.match(/\b(19|20)\d{2}\b/);
  if (match) {
    const year = parseInt(match[0]);
    const currentYear = new Date().getFullYear();
    if (year >= 1900 && year <= currentYear - 2) return year;
  }
  return null;
}

/**
 * Query Wayback Machine CDX API for the OLDEST available snapshot.
 * Returns the year of the earliest archived page.
 */
export async function getEarliestSnapshotYear(
  url: string
): Promise<number | null> {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const domain = parsed.hostname;

    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx` +
      `?url=${domain}&output=json&limit=1` +
      `&filter=statuscode:200&fl=timestamp`;

    const res = await fetch(cdxUrl, {
      headers: WAYBACK_HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json();

    if (data.length < 2) return null;
    const timestamp = data[1][0];
    const year = parseInt(timestamp.slice(0, 4));
    if (year >= 1996 && year <= 2030) return year;
  } catch {
    // Timeout or network error
  }
  return null;
}

/**
 * Use Claude with web_search to find the company's founding year online.
 */
export async function searchFoundingYearWeb(
  client: Anthropic,
  url: string
): Promise<number | null> {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const stem = parsed.hostname.replace("www.", "").split(".")[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      { type: "web_search_20250305", name: "web_search", max_uses: 2 },
    ];

    const resp = await callClaude(client, 2, {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      tools,
      messages: [
        {
          role: "user",
          content: `Search the web to find when the company "${stem}" (website: ${url}) was founded or established.

Return only a 4-digit year if you are confident (e.g. 1998).
Do not return years from the last 2 years.
If you cannot determine it, return exactly: null`,
        },
      ],
    });

    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length === 0) return null;
    const raw = textBlocks[textBlocks.length - 1].text.trim();
    const match = raw.match(/\b(19|20)\d{2}\b/);
    if (match) {
      const year = parseInt(match[0]);
      const currentYear = new Date().getFullYear();
      if (year >= 1900 && year <= currentYear - 2) return year;
    }
  } catch {
    // Non-critical
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wayback Machine
// ---------------------------------------------------------------------------

type WaybackCandidate = { url: string; timestamp: string };

/** Diagnostic status returned alongside Wayback candidates. */
export type WaybackStatus =
  | "ok"
  | "empty"
  | "timeout"
  | "http_error"
  | "network_error"
  | "fallback_used";

export type WaybackLookupResult = {
  candidates: WaybackCandidate[];
  status: WaybackStatus;
};

/**
 * Query Wayback Machine CDX API for snapshots between fromDate and toDate.
 * Returns { candidates, status }, where status surfaces why a lookup
 * returned nothing (so the UI can tell "Wayback is rate-limiting us" from
 * "this domain genuinely has no archived snapshots").
 *
 * If the primary CDX call returns no rows or fails, falls back once to the
 * Availability API (a much lighter endpoint that often succeeds when CDX
 * times out) and returns that single closest snapshot.
 */
export async function getWaybackCandidates(
  url: string,
  fromDate: string,
  toDate: string
): Promise<WaybackLookupResult> {
  let primaryStatus: WaybackStatus = "empty";
  let domain = "";
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    domain = parsed.hostname;

    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx` +
      `?url=${domain}&output=json` +
      `&from=${fromDate}&to=${toDate}` +
      `&limit=15&filter=statuscode:200` +
      `&collapse=timestamp:4&fl=timestamp,original`;

    const res = await fetch(cdxUrl, {
      headers: WAYBACK_HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      primaryStatus = "http_error";
    } else {
      const data = await res.json();
      if (data.length < 2) {
        primaryStatus = "empty";
      } else {
        const candidates = data.slice(1).map((row: string[]) => ({
          url: `https://web.archive.org/web/${row[0]}/${row[1]}`,
          timestamp: row[0],
        }));
        return { candidates, status: "ok" };
      }
    }
  } catch (err) {
    primaryStatus =
      err instanceof Error && err.name === "TimeoutError"
        ? "timeout"
        : "network_error";
  }

  // Fallback: the Availability API is far lighter than CDX and often succeeds
  // when CDX times out or returns nothing. Aim it at the middle of the window.
  if (domain) {
    const targetYear = Math.floor(
      (parseInt(fromDate.slice(0, 4)) + parseInt(toDate.slice(0, 4))) / 2
    );
    const fallback = await getWaybackFallbackSnapshot(domain, targetYear);
    if (fallback) {
      return { candidates: [fallback], status: "fallback_used" };
    }
  }

  return { candidates: [], status: primaryStatus };
}

/**
 * Single-shot lookup against the Wayback Availability API. Returns the
 * snapshot closest to targetYear, or null. Used as a fallback when CDX
 * returns nothing or fails.
 */
export async function getWaybackFallbackSnapshot(
  domain: string,
  targetYear: number
): Promise<WaybackCandidate | null> {
  try {
    const params = new URLSearchParams({
      url: domain,
      timestamp: String(targetYear),
    });
    const res = await fetch(
      `https://archive.org/wayback/available?${params.toString()}`,
      {
        headers: WAYBACK_HEADERS,
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const closest = data?.archived_snapshots?.closest;
    if (
      closest &&
      closest.available &&
      typeof closest.url === "string" &&
      typeof closest.timestamp === "string"
    ) {
      return { url: closest.url, timestamp: closest.timestamp };
    }
  } catch {
    /* silent */
  }
  return null;
}

/**
 * Fetch an archived page from Wayback Machine via direct HTTP request.
 * Uses fetchRawText (not Jina Reader — Jina can't handle Wayback URLs).
 * Returns text content + skip reason if rejected.
 */
export async function fetchWaybackSnapshot(
  archiveUrl: string,
  domainStem: string
): Promise<{ text: string | null; skipReason: string | null }> {
  const text = await fetchRawText(archiveUrl, 20000, 8000);
  if (!text || text.length < 300)
    return { text: null, skipReason: "too little content" };
  if (isParkedPage(text))
    return { text: null, skipReason: "looks like a parked domain page" };
  // Check for domain stem — also try without spaces/hyphens (matches Python version)
  const textLower = text.toLowerCase();
  const stemLower = domainStem.toLowerCase();
  const textNoSpace = textLower.replace(/[\s\-_]/g, "");
  if (!textLower.includes(stemLower) && !textNoSpace.includes(stemLower))
    return {
      text: null,
      skipReason: "company name not found (likely a prior domain owner)",
    };
  return { text, skipReason: null };
}

/**
 * Search Wayback Machine CDX for archived interior pages matching a keyword prefix.
 * E.g., keyword "product" finds /products, /products.html, /products/index.php, etc.
 * Returns up to `limit` candidates.
 */
export async function getInteriorCandidates(
  domain: string,
  keyword: string,
  fromDate: string,
  toDate: string,
  limit = 3
): Promise<WaybackCandidate[]> {
  try {
    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx` +
      `?url=${domain}/${keyword}*&matchType=prefix&output=json` +
      `&from=${fromDate}&to=${toDate}` +
      `&limit=${limit}&filter=statuscode:200` +
      `&collapse=timestamp:4` +
      `&fl=timestamp,original`;

    const res = await fetch(cdxUrl, {
      headers: WAYBACK_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();

    if (data.length < 2) return [];

    return data.slice(1).map((row: string[]) => ({
      url: `https://web.archive.org/web/${row[0]}/${row[1]}`,
      timestamp: row[0],
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Product Comparison
// ---------------------------------------------------------------------------

/**
 * Ask Claude to identify one product present on the old site but absent from current.
 */
export async function findDiscontinued(
  client: Anthropic,
  oldProducts: string[],
  currentProducts: string[],
  periodLabel: string
): Promise<string | null> {
  if (oldProducts.length === 0 || currentProducts.length === 0) return null;

  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: `You are helping with M&A research. Below are two lists of products/services from the same company at different points in time.

OLD SITE (${periodLabel}):
${JSON.stringify(oldProducts, null, 2)}

CURRENT SITE:
${JSON.stringify(currentProducts, null, 2)}

Find ONE product or service from the OLD list that does NOT have a clear match on the current site. Consider all of these scenarios:
- The exact name is no longer present
- The product was likely renamed to something different
- A service line was merged into another offering
- An old branded name was replaced with a generic description
- A product category or capability was dropped entirely

You MUST return a result unless the two lists are virtually identical (same items, same names). Pick the most specific and interesting one — a named product or distinct service line, not a generic category like "consulting" or "support."

Return only the product/service name from the OLD list. No explanation.`,
      },
    ],
  });

  const raw = resp.content[0].text.trim();
  if (raw.toLowerCase() === "none" || raw.length > 200) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Address Extraction
// ---------------------------------------------------------------------------

/**
 * Where the company's address/location came from, plus a link the user can
 * click to verify it. `sourceUrl` is the real web page the address was found on
 * when we can capture it, otherwise a Google Maps link for the location.
 */
export type AddressResolution = {
  address: string | null; // "123 Main St, Reno, NV" | "Reno, NV" | null
  source: string | null; // "company website" | "web search (domain)" | "web search (company name)"
  sourceUrl: string | null; // real source page URL, else a Google Maps link, else null
  confidence: "exact" | "city" | "none";
};

/**
 * Pull the first real http(s) source URL out of a Claude web-search response.
 * Web search returns `web_search_tool_result` blocks (a list of results, each
 * with a `url`) and text blocks may carry a `citations` array with `url`s. The
 * block shapes are loosely typed, so this is fully defensive — any miss just
 * returns null and the caller falls back to a Google Maps link.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFirstCitationUrl(resp: any): string | null {
  const isHttp = (u: unknown): u is string =>
    typeof u === "string" && /^https?:\/\//i.test(u);

  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  for (const block of blocks) {
    // web_search_tool_result → content is a list of results, each with a url
    if (block?.type === "web_search_tool_result") {
      const results = Array.isArray(block.content) ? block.content : [];
      for (const r of results) {
        if (isHttp(r?.url)) return r.url;
      }
    }
    // text blocks can carry citations with urls
    const citations = Array.isArray(block?.citations) ? block.citations : [];
    for (const c of citations) {
      if (isHttp(c?.url)) return c.url;
    }
  }
  return null;
}

/** A Google Maps search link for an address/city — the guaranteed fallback. */
function buildMapsLink(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    address
  )}`;
}

/**
 * Derive a search-quality company name from the domain stem (e.g.
 * "acme-software.com" → "Acme-software"). Not a perfect legal name — it only
 * needs to qualify a web search like "<name> headquarters address". Mirrors the
 * fallback-name logic used in researchCompanyAnchors.
 */
export function quickCompanyName(url: string): string {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const stem = parsed.hostname.replace("www.", "").split(".")[0];
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  } catch {
    return "";
  }
}

/** street number present → "exact", comma + region only → "city". */
function addressConfidence(address: string): "exact" | "city" {
  return /\d/.test(address) ? "exact" : "city";
}

/**
 * Resolve the company's address/location and record where it came from.
 * Tries scraped page text, then web search by domain, then web search by
 * company name (city-level is acceptable) so we almost always land a location.
 */
export async function extractAddress(
  client: Anthropic,
  currentText: string,
  url: string,
  companyName?: string
): Promise<AddressResolution> {
  // Attempt 1: Extract from already-scraped text
  const fromText = await askClaudeForAddress(client, currentText);
  if (fromText) {
    return {
      address: fromText,
      source: "company website",
      sourceUrl: url.startsWith("http") ? url : `https://${url}`,
      confidence: addressConfidence(fromText),
    };
  }

  // Attempt 2: Use Claude web search to find the headquarters address
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const domain = parsed.hostname.replace("www.", "");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ];

    const resp = await callClaude(client, 2, {
      model: "claude-sonnet-4-6",
      max_tokens: 150,
      tools,
      messages: [
        {
          role: "user",
          content: `Use web search to find the headquarters location for the company whose website is ${domain}.

Try searches like "${domain} headquarters", "${domain} contact", "${domain} about us", and "${domain} location".

ONLY return a location that clearly belongs to this specific company.
- Best case: full street address as a single line (e.g. '123 Main St, Denver, CO 80202').
- If no street address is available, city + state/country is still useful (e.g. 'Reno, NV' or 'Bel Air, MD' or 'Toronto, ON').
- Return ONLY the address/location, no commentary or preamble.

If you cannot find any location for this specific company, return exactly: null`,
        },
      ],
    });

    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length > 0) {
      const raw = textBlocks[textBlocks.length - 1].text.trim();
      const validated = validateAddress(raw);
      if (validated) {
        return {
          address: validated,
          source: "web search (domain)",
          sourceUrl: extractFirstCitationUrl(resp) ?? buildMapsLink(validated),
          confidence: addressConfidence(validated),
        };
      }
    }
  } catch {
    // Non-critical
  }

  // Attempt 3: Web search by COMPANY NAME (city-level is acceptable).
  // This is the fallback when the site has no address and the domain search
  // came up empty — e.g. "<name> software headquarters address".
  const name = companyName || quickCompanyName(url);
  if (name) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: any[] = [
        { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      ];

      const resp = await callClaude(client, 2, {
        model: "claude-sonnet-4-6",
        max_tokens: 150,
        tools,
        messages: [
          {
            role: "user",
            content: `Use web search to find where the software company "${name}" is based.

Try searches like "${name} software headquarters address", "${name} head office", "${name} company location", and "${name} contact".

ONLY return a location that clearly belongs to this specific company.
- Best case: full street address as a single line (e.g. '123 Main St, Denver, CO 80202').
- A city + state/country alone is perfectly fine and expected here (e.g. 'Reno, NV' or 'Bel Air, MD' or 'Toronto, ON').
- Return ONLY the address/location, no commentary or preamble.

If you cannot find any location for this specific company, return exactly: null`,
          },
        ],
      });

      const textBlocks = resp.content.filter(
        (b: { type: string }) => b.type === "text"
      );
      if (textBlocks.length > 0) {
        const raw = textBlocks[textBlocks.length - 1].text.trim();
        const validated = validateAddress(raw);
        if (validated) {
          return {
            address: validated,
            source: "web search (company name)",
            sourceUrl: extractFirstCitationUrl(resp) ?? buildMapsLink(validated),
            confidence: addressConfidence(validated),
          };
        }
      }
    } catch {
      // Non-critical
    }
  }

  return { address: null, source: null, sourceUrl: null, confidence: "none" };
}

async function askClaudeForAddress(
  client: Anthropic,
  text: string
): Promise<string | null> {
  if (!text || text.length < 100) return null;

  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: `Extract the company's HEADQUARTERS or main office location from this text.
If multiple addresses appear, use these priority rules:
1. An address explicitly labeled 'headquarters', 'HQ', 'corporate office', or 'main office'
2. The address associated with the company's home city or founding location
3. If no label distinguishes them, return the first address listed

Prefer the full street address (e.g. '123 Main St, Denver, CO 80202').
If only a city/state is shown, that's still useful — return it (e.g. 'Denver, CO' or 'Bel Air, MD').
Do not include P.O. boxes or branch office addresses when a headquarters is identifiable.
Return ONLY the address/location as a single line — no preamble, no commentary.
If no location at all is present, return exactly: null

Text:
${text.slice(0, 4000)}`,
      },
    ],
  });

  const raw = resp.content[0].text.trim();
  return validateAddress(raw);
}

/**
 * Shared sanity check. Accepts:
 *  - "123 Main St, Denver, CO 80202" (street address with digit)
 *  - "Denver, CO" / "Bel Air, MD" (city + 2-letter state)
 *  - "Bel Air, Maryland" / "Wilmington, North Carolina" (city + full state)
 * Rejects: null/none, very short, very long (likely prose), no comma & no digit.
 */
function validateAddress(raw: string): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "null" || lower === "none" || lower === "n/a") return null;
  if (raw.length < 4 || raw.length > 200) return null;

  // Strip common preambles Claude sometimes adds
  const cleaned = raw
    .replace(/^(address|location|hq|headquarters)\s*[:\-]\s*/i, "")
    .trim();

  // Must look like an address: digit (street number) OR comma + capitalized region
  const hasDigit = /\d/.test(cleaned);
  const hasCommaRegion =
    /,\s*[A-Z]{2}\b/.test(cleaned) || /,\s*[A-Z][a-z]+/.test(cleaned);
  if (!hasDigit && !hasCommaRegion) return null;

  // Reject obvious commentary even if it has a comma
  if (/\bi (cannot|can't|couldn't|don't|am unable)/i.test(cleaned)) return null;

  return cleaned;
}

// ---------------------------------------------------------------------------
// Restaurant Recommendations
// ---------------------------------------------------------------------------

/** Restaurant search result: the restaurants plus the city the search used/found. */
export type RestaurantSearchResult = {
  restaurants: { name: string; description: string }[];
  /** "City, ST" the search located (only meaningful when we had no address) */
  city: string | null;
};

/** Run one restaurant web-search prompt and parse the JSON out of it. */
async function runRestaurantSearch(
  client: Anthropic,
  prompt: string
): Promise<RestaurantSearchResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    { type: "web_search_20250305", name: "web_search", max_uses: 6 },
  ];

  try {
    const resp = await callClaude(client, 2, {
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      tools,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length === 0) return { restaurants: [], city: null };
    const raw = textBlocks[textBlocks.length - 1].text.trim();
    return parseRestaurantJson(raw);
  } catch {
    return { restaurants: [], city: null };
  }
}

/**
 * Find ~3 business dinner restaurants for a company. Always attempts a search:
 *  - with an address → search that city
 *  - with no address but a company name → have web search locate the city
 *    first, and REPORT BACK the city it found (so the caller can display a
 *    location even when address extraction failed)
 *  - if the first pass is thin → one looser retry that drops the "business
 *    dinner" qualifier
 * Returns empty results only when every attempt genuinely comes up empty.
 */
export async function findRestaurants(
  client: Anthropic,
  address: string | null,
  companyName?: string
): Promise<RestaurantSearchResult> {
  // Derive a "City, State" string from the address when we have one.
  let cityState = "";
  if (address) {
    const parts = address.split(",").map((p) => p.trim());
    cityState =
      parts.length >= 2
        ? parts
            .slice(-2)
            .join(", ")
            .replace(/\s+\d{5}(-\d{4})?$/, "")
            .trim()
        : address;
  }

  const jsonFormat = `Respond with ONLY a JSON object. No preamble, no explanation, no markdown fences. Format:
{"city":"City, ST","restaurants":[{"name":"Actual Restaurant Name","description":"One short sentence on why it works for a business dinner."}, ...]}
"city" is the city and state/region the restaurants are in.`;

  // Primary search.
  let primaryPrompt: string;
  if (cityState) {
    primaryPrompt = `Use the web_search tool to find 3 well-known restaurants near ${cityState} that are good for a professional business dinner. Try queries like "best business dinner restaurants ${cityState}", "fine dining ${cityState}", and "upscale restaurants ${cityState}". Use multiple searches if the first one is thin.

Prefer established places — fine dining, upscale steakhouses, hotel restaurants, or notable gastropubs that come up on local food guides, TripAdvisor, Eater, or similar sources. Avoid fast food, chains, and anything obviously casual.

If the city is small and you cannot find 3 strong candidates, return whatever real restaurants you DO find — even 1 or 2 is fine. Only return an empty restaurants array if there are literally no restaurant search results at all.

${jsonFormat}`;
  } else if (companyName) {
    primaryPrompt = `Use the web_search tool. First find what city the software company "${companyName}" is based in (search "${companyName} headquarters" or "${companyName} location"). Then find 3 well-known restaurants in that city that are good for a professional business dinner.

Prefer established places — fine dining, upscale steakhouses, hotel restaurants, or notable gastropubs that come up on local food guides, TripAdvisor, Eater, or similar sources. Avoid fast food, chains, and anything obviously casual.

Return whatever real restaurants you find — even 1 or 2 is fine. IMPORTANT: even if you find NO restaurants, still return the "city" you determined for the company (or null if you truly could not determine it).

${jsonFormat}`;
  } else {
    return { restaurants: [], city: null };
  }

  const primary = await runRestaurantSearch(client, primaryPrompt);
  // When we started from a known address, report that city back.
  if (cityState && !primary.city) primary.city = cityState;
  if (primary.restaurants.length > 0) return primary;

  // Looser retry: drop the "business dinner" framing, accept any well-reviewed
  // upscale sit-down spot. Use the city from the primary pass if it found one.
  const retryCity = cityState || primary.city;
  if (retryCity) {
    const broad = await runRestaurantSearch(
      client,
      `Use the web_search tool to find up to 3 well-reviewed, upscale sit-down restaurants in ${retryCity} (not fast food or chains). Try "best restaurants ${retryCity}" and "${retryCity} restaurants TripAdvisor".

Return whatever real restaurants you find — even 1 or 2 is fine. Only return an empty restaurants array if there are literally no results.

${jsonFormat}`
    );
    if (!broad.city) broad.city = retryCity;
    if (broad.restaurants.length > 0) return broad;
    return { restaurants: [], city: retryCity };
  }

  return { restaurants: [], city: primary.city };
}

function parseRestaurantJson(raw: string): RestaurantSearchResult {
  // Phrases that signal Claude refused or fell back to a placeholder rather
  // than an actual restaurant. Match conservatively against names only — a
  // real restaurant called "The Cannot Saint" should still pass.
  const BAD_SIGNALS = [
    "no suitable",
    "not found",
    "no restaurant",
    "unable to find",
    "could not find",
    "n/a",
    "placeholder",
  ];

  function isReal(r: { name: string }): boolean {
    const name = r.name.toLowerCase().trim();
    if (!name) return false;
    if (name.length < 3) return false;
    return !BAD_SIGNALS.some((sig) => name.includes(sig));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function cleanList(list: any[]): { name: string; description: string }[] {
    return list
      .filter((r) => typeof r === "object" && r?.name && isReal(r))
      .map((r) => ({ name: r.name, description: r.description || "" }))
      .slice(0, 3);
  }

  /** City sanity check: short string with a comma or known region shape. */
  function cleanCity(c: unknown): string | null {
    if (typeof c !== "string") return null;
    const t = c.trim();
    if (!t || t.toLowerCase() === "null" || t.length < 3 || t.length > 80)
      return null;
    return t;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fromParsed(parsed: any): RestaurantSearchResult | null {
    // New format: {"city": "...", "restaurants": [...]}
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const list = Array.isArray(parsed.restaurants) ? parsed.restaurants : [];
      return { restaurants: cleanList(list), city: cleanCity(parsed.city) };
    }
    // Legacy format: bare array of restaurants
    if (Array.isArray(parsed)) {
      return { restaurants: cleanList(parsed), city: null };
    }
    return null;
  }

  // Try direct JSON parse
  try {
    const result = fromParsed(JSON.parse(raw));
    if (result) return result;
  } catch {
    // Try extracting JSON from prose below
  }

  // Extract a JSON object from prose
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const result = fromParsed(JSON.parse(objMatch[0]));
      if (result) return result;
    } catch {
      // Parse failure — try array extraction
    }
  }

  // Extract a JSON array from prose (legacy)
  const arrMatch = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrMatch) {
    try {
      const result = fromParsed(JSON.parse(arrMatch[0]));
      if (result) return result;
    } catch {
      // Parse failure
    }
  }

  return { restaurants: [], city: null };
}

// ---------------------------------------------------------------------------
// Portfolio Matching
// ---------------------------------------------------------------------------

/**
 * Load all portfolio group .md files from content/groups/.
 *
 * The groups folder is organized as one folder per MAIN industry group
 * (e.g. "Construction and Diversified Materials", "Agriculture", "Logistics",
 * "Manufacturing"), each containing one .md file per sub-vertical.
 *
 * Returns a map keyed by relative path, e.g.
 *   "Manufacturing/aftermarket-service.md" → file content
 * Loose .md files sitting directly in content/groups (legacy layout) are
 * still picked up, keyed by bare filename.
 */
export function loadGroupFiles(): Record<string, string> {
  const groupsDir = path.join(process.cwd(), "content", "groups");
  const groups: Record<string, string> = {};

  try {
    const entries = fs.readdirSync(groupsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name.toUpperCase() !== "CLAUDE.MD"
      ) {
        groups[entry.name] = fs.readFileSync(
          path.join(groupsDir, entry.name),
          "utf-8"
        );
      } else if (entry.isDirectory()) {
        try {
          const subFiles = fs
            .readdirSync(path.join(groupsDir, entry.name))
            .filter(
              (f) => f.endsWith(".md") && f.toUpperCase() !== "CLAUDE.MD"
            );
          for (const f of subFiles) {
            groups[`${entry.name}/${f}`] = fs.readFileSync(
              path.join(groupsDir, entry.name, f),
              "utf-8"
            );
          }
        } catch {
          // Unreadable subfolder — skip
        }
      }
    }
  } catch {
    // Directory not found or read error
  }

  return groups;
}

/**
 * Split a group map key into its main-group folder and filename.
 * "Manufacturing/aftermarket-service.md" → { mainGroup: "Manufacturing", fileName: "aftermarket-service.md" }
 * "bulk-liquids.md" (legacy root file)   → { mainGroup: null, fileName: "bulk-liquids.md" }
 */
function splitGroupKey(key: string): {
  mainGroup: string | null;
  fileName: string;
} {
  const idx = key.indexOf("/");
  if (idx === -1) return { mainGroup: null, fileName: key };
  return { mainGroup: key.slice(0, idx), fileName: key.slice(idx + 1) };
}

/** Result of classifying a company against the portfolio groups. */
export type GroupMatch = {
  matched: boolean;
  /** Sub-vertical display name, e.g. "Aftermarket Service" (kept as `group` for backward compat) */
  group: string | null;
  /** Main industry group folder, e.g. "Manufacturing" — null for legacy root-level files */
  mainGroup: string | null;
  confidence: number | null;
};

/**
 * Ask Claude to classify the company into the best-fit portfolio group.
 * Returns both the MAIN industry group (the folder, e.g. "Agriculture") and
 * the sub-vertical (the file, e.g. "Grain Crop").
 */
export async function matchGroup(
  client: Anthropic,
  currentText: string,
  groups: Record<string, string>
): Promise<GroupMatch> {
  if (Object.keys(groups).length === 0) {
    return { matched: false, group: null, mainGroup: null, confidence: null };
  }

  const summaries = Object.entries(groups)
    .map(([name, content]) => `FILE: ${name}\n${content.slice(0, 700)}`)
    .join("\n\n");

  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: `Based on this company's website content, which group file is the best fit?

The files are organized as "Main Industry Group/sub-vertical.md" — the folder is the main industry group (e.g. Construction and Diversified Materials, Agriculture, Logistics, Manufacturing) and the file is the specific sub-vertical within it. Pick the single best-fitting FILE.

COMPANY WEBSITE:
${currentText.slice(0, 8000)}

GROUP FILES:
${summaries}

Return a JSON object (no markdown) with this format:
{"file":"Construction and Diversified Materials/mining.md","confidence":85}

- "file" is the exact file key (including its folder) of the best-matching group, or "NO_MATCH" if none fit.
- "confidence" is a number from 0-100 representing how confident you are in the match.
  90+ = very clear fit, 70-89 = reasonable fit, 50-69 = borderline, <50 = weak.`,
      },
    ],
  });

  const raw = resp.content[0].text.trim();

  // Parse JSON response
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as { file: string; confidence: number };

    if (!parsed.file || parsed.file.toUpperCase() === "NO_MATCH") {
      return {
        matched: false,
        group: null,
        mainGroup: null,
        confidence: parsed.confidence ?? null,
      };
    }

    const resolvedFile = resolveMatchedFile(parsed.file, groups);
    const { mainGroup } = splitGroupKey(resolvedFile);
    return {
      matched: true,
      group: displayName(resolvedFile),
      mainGroup,
      confidence: parsed.confidence ?? null,
    };
  } catch {
    // Fallback: try to parse as plain text (backward compat)
    const text = raw.replace(/['"]/g, "");
    if (text.toUpperCase() === "NO_MATCH") {
      return { matched: false, group: null, mainGroup: null, confidence: null };
    }
    const resolvedFile = resolveMatchedFile(text, groups);
    const { mainGroup } = splitGroupKey(resolvedFile);
    return {
      matched: true,
      group: displayName(resolvedFile),
      mainGroup,
      confidence: null,
    };
  }
}

function resolveMatchedFile(
  matched: string,
  groups: Record<string, string>
): string {
  if (matched in groups) return matched;
  const lower = matched.toLowerCase();
  const lowerBase = splitGroupKey(matched).fileName.toLowerCase();
  for (const key of Object.keys(groups)) {
    const keyLower = key.toLowerCase();
    const baseLower = splitGroupKey(key).fileName.toLowerCase();
    if (
      // Model returned bare filename for a file that lives in a folder
      baseLower === lower ||
      baseLower === lowerBase ||
      lower.includes(keyLower) ||
      baseLower.replace(".md", "").includes(lowerBase.replace(".md", ""))
    ) {
      return key;
    }
  }
  return Object.keys(groups)[0];
}

/** Convert 'Manufacturing/aftermarket-service.md' → 'Aftermarket Service' */
function displayName(fileKey: string): string {
  return splitGroupKey(fileKey)
    .fileName.replace(".md", "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Outreach Generation
// ---------------------------------------------------------------------------

/**
 * Extract the outreach paragraph from a group file's content.
 */
export function extractOutreachParagraph(groupContent: string): string {
  const marker = "## Core Outreach Paragraph";
  if (groupContent.includes(marker)) {
    const after = groupContent.split(marker)[1].trim();
    const lines: string[] = [];
    for (const line of after.split("\n")) {
      if (line.startsWith("##")) break;
      lines.push(line);
    }
    return lines.join("\n").trim();
  }
  return groupContent.trim();
}

/**
 * Ask Claude to personalize the outreach paragraph with a company-specific reference.
 */
export async function personalizeOutreach(
  client: Anthropic,
  paragraph: string,
  url: string,
  currentText: string,
  products: string[]
): Promise<string> {
  const productsHint =
    products.length > 0
      ? `\nThe company's specific named products include: ${products.slice(0, 6).join(", ")}. If possible, mention one of these by name rather than describing the company generically.\n`
      : "";

  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `Here is an outreach paragraph. Add one company-specific reference to the company at ${url} that makes it feel written for them specifically. The sentence should sound like something you'd say out loud to a founder over coffee. Use short clauses, plain language, and avoid stacking multiple concepts into a single noun phrase.
${productsHint}
Rules:
- Do NOT rewrite the paragraph
- Do NOT change the structure or length meaningfully
- Keep the tone identical
- Prefer mentioning a specific product name or niche market over generic industry descriptions
- Do NOT use em dashes (—) anywhere in the output

PARAGRAPH:
${paragraph}

COMPANY CONTEXT:
${currentText.slice(0, 2500)}

Return only the modified paragraph. Nothing else.`,
      },
    ],
  });

  let result = resp.content[0].text.trim();
  // Safety net: replace any em dashes with a comma
  result = result.replace(/\s*—\s*/g, ", ");
  return result;
}

// ---------------------------------------------------------------------------
// Email Opening Hook — Anchor Research
// ---------------------------------------------------------------------------

/**
 * A distinctive, verifiable artifact from a company's history that can be
 * slotted into the "I have studied X going back to ${ANCHOR}" opener.
 */
export type CompanyAnchor = {
  type:
    | "former_name" // e.g. "the days operating as Resolution Systems"
    | "product_release" // e.g. "the release of Herbst Attendance"
    | "distinctive_moment" // rebrand, acquisition, founder anecdote
    | "obscure_trivia" // weird artifact from old snapshots
    | "early_niche"; // a specific named customer segment they pioneered
  anchor: string; // exact phrase to slot after "going back to"
  evidence: string; // 1 sentence: where this came from
};

/**
 * Research a company for distinctive, hook-worthy anchors using Claude with
 * web_search. Returns a canonical companyName and up to 5 anchors ranked
 * most-specific first.
 *
 * Failure-tolerant: on any error returns a domain-stem fallback companyName
 * and an empty anchors array, letting generateEmailHook() degrade to a
 * local-data-only hook.
 */
export async function researchCompanyAnchors(
  client: Anthropic,
  url: string,
  currentText: string,
  products: string[],
  oldProducts: string[],
  discontinued: string | null,
  archiveYear: string | null
): Promise<{ companyName: string; anchors: CompanyAnchor[] }> {
  const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
  const stem = parsed.hostname.replace("www.", "").split(".")[0];
  const fallbackName = stem.charAt(0).toUpperCase() + stem.slice(1);

  try {
    const productsHint =
      products.length > 0
        ? `\nCurrent products: ${products.slice(0, 8).join(", ")}`
        : "";
    const oldProductsHint =
      oldProducts.length > 0
        ? `\nHistorical product names (from Wayback Machine${archiveYear ? `, ${archiveYear}` : ""}): ${oldProducts.slice(0, 8).join(", ")}`
        : "";
    const discontinuedHint = discontinued
      ? `\nDiscontinued product (appeared on an old snapshot but absent today): ${discontinued}`
      : "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      { type: "web_search_20250305", name: "web_search", max_uses: 4 },
    ];

    const resp = await callClaude(client, 2, {
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      tools,
      messages: [
        {
          role: "user",
          content: `You are helping write a personal cold-outreach hook. The hook will start "I have studied {Company} going back to {ANCHOR}." where ANCHOR is a SPECIFIC, VERIFIABLE artifact from the company's history. Generic descriptions of current products are unusable.

Examples of great anchors (these came from real research, not the homepage):
- "the days operating as Resolution Systems" (a former company name)
- "the release of Herbst Attendance" (a specific named product launch)
- "the release of ArcMiner" (a specific named product launch)
- "the days when the Okappy mascot would appear on the Team page of the website" (obscure trivia from old snapshots)

TARGET COMPANY: ${url}${productsHint}${oldProductsHint}${discontinuedHint}

Excerpt from the company's current website:
${currentText.slice(0, 1500)}

YOUR TASK:
1. Identify the company's canonical brand name (e.g. "MaxMine", not "maxmine.com").
2. Use web_search to research the company's history. Look for:
   - A FORMER NAME (rebrand, prior LLC, predecessor entity, acquired-from name).
   - A SPECIFIC PRODUCT LAUNCH from their early years (with the actual product name).
   - A DISTINCTIVE MOMENT (acquisition, merger, milestone press release).
   - OBSCURE TRIVIA (something only a careful researcher would know).
   - An EARLY NICHE they pioneered (a specific named customer segment, not "the construction industry").
3. Return up to 5 candidate anchors, ranked most-specific first.

ANCHOR FORMAT:
- The "anchor" string is the EXACT phrase that goes after "going back to". Examples:
  - "the days operating as Resolution Systems"
  - "the release of Herbst Attendance in 2008"
  - "the Okappy mascot's appearance on your early Team page"
- Never use a bare year. Never use a generic descriptor of what they do now.
- Each anchor must be falsifiable: a reader could in principle look it up.

Return STRICT JSON only, no markdown fences, no commentary:
{
  "companyName": "MaxMine",
  "anchors": [
    {"type": "former_name", "anchor": "the days operating as Resolution Systems", "evidence": "one sentence: where you found this"}
  ]
}

If you genuinely cannot find anything specific via web search, still return the companyName and an empty anchors array. Do not invent.`,
        },
      ],
    });

    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length === 0) return { companyName: fallbackName, anchors: [] };
    const raw = textBlocks[textBlocks.length - 1].text.trim();
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsedJson = JSON.parse(cleaned) as {
      companyName?: string;
      anchors?: CompanyAnchor[];
    };

    const companyName =
      typeof parsedJson.companyName === "string" && parsedJson.companyName.trim()
        ? parsedJson.companyName.trim()
        : fallbackName;
    const anchors = Array.isArray(parsedJson.anchors)
      ? parsedJson.anchors
          .slice(0, 5)
          .filter(
            (a) =>
              a &&
              typeof a.anchor === "string" &&
              a.anchor.trim().length > 0 &&
              typeof a.type === "string"
          )
      : [];

    return { companyName, anchors };
  } catch {
    return { companyName: fallbackName, anchors: [] };
  }
}

/**
 * Generate a 1-2 sentence personalized email opener (the "hook").
 *
 * Selects the most-specific anchor available, in this priority order:
 *   1. Researched anchors (web_search results from researchCompanyAnchors)
 *   2. A discontinued product from a Wayback snapshot
 *   3. A specific historical product name from oldProducts
 *   4. An early niche they pioneered, named specifically
 *   5. (Last resort) a founding year + ONE specific clause about what they
 *      were doing at that moment. Never a bare year.
 *
 * Generic descriptors of current product/positioning are explicitly banned.
 */
export async function generateEmailHook(
  client: Anthropic,
  companyName: string,
  url: string,
  currentText: string,
  products: string[],
  foundingYear: number | null,
  oldProducts: string[],
  discontinued: string | null,
  archiveYear: string | null,
  anchors: CompanyAnchor[],
  matchedGroupContent: string
): Promise<string> {
  const anchorsBlock =
    anchors.length > 0
      ? `\nRESEARCHED ANCHORS (highest-signal — prefer these):\n${anchors
          .map(
            (a, i) =>
              `${i + 1}. [${a.type}] "${a.anchor}" (${a.evidence ?? "no evidence"})`
          )
          .join("\n")}\n`
      : "";

  const oldProductsBlock =
    oldProducts.length > 0
      ? `\nHISTORICAL PRODUCTS${archiveYear ? ` (from ${archiveYear} Wayback snapshot)` : ""}: ${oldProducts.slice(0, 8).join(", ")}\n`
      : "";

  const discontinuedBlock = discontinued
    ? `\nDISCONTINUED PRODUCT (appeared on an old snapshot but absent today): ${discontinued}\n`
    : "";

  const productsBlock =
    products.length > 0
      ? `\nCURRENT PRODUCTS: ${products.slice(0, 8).join(", ")}\n`
      : "";

  const foundingYearBlock = foundingYear
    ? `\nFOUNDING YEAR (use only as last resort, and only when attached to a specific clause): ${foundingYear}\n`
    : "";

  const resp = await callClaude(client, 2, {
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `Write a personalized single-sentence cold-email OPENER (a "hook") for the company "${companyName}" (${url}). The hook is the very first thing the recipient reads. Its job is to prove we did real homework on this specific company so the email feels written for them, not blasted from a template.

GOLDEN EXAMPLES (target style — specific, falsifiable, written-not-templated):
- "I have studied MaxMine going back to the days operating as Resolution Systems."
- "I have followed Herbst going back to the release of Herbst Attendance."
- "I have studied Pacific GeoTech going back to the release of ArcMiner."
- "I have studied Okappy going back to the days when the Okappy mascot would appear on the Team page of the website."

OPENER FORMULA:
  "I have [studied|followed] ${companyName} going back to {ANCHOR}."
- "studied" for observational angles (product releases, former names, trivia).
- "followed" for relational / longitudinal angles.
- {ANCHOR} must point to a SPECIFIC, VERIFIABLE artifact, not a generic descriptor.

ANCHOR HIERARCHY (pick the most specific available — do NOT skip past a stronger tier when one is in the inputs):
  1. Former company name (e.g. "the days operating as Resolution Systems")
  2. Specific product release/launch with the product NAMED (e.g. "the release of ArcMiner")
  3. Distinctive historical moment (rebrand, acquisition, milestone press)
  4. Obscure trivia from old snapshots (e.g. "the Okappy mascot on the Team page")
  5. EARLY NICHE they pioneered, named specifically (e.g. "the days you were the only option for Australian iron-ore haul-truck operators")
  6. LAST RESORT: founding year + ONE specific clause about what they were doing at that moment. Never a bare year. Never a generic positioning statement.

HARD BANS:
- Generic descriptions of current products/positioning ("their focus on real-time worksite intelligence", "Smart Maintenance Management CMMS built for industrial asset-heavy environments"). If a reader could have written it after a 5-second glance at the homepage, it is banned.
- Bare-year openers like "I've studied your business going back to 2002." with no specific clause after.
- Hype words: "leading", "innovative", "cutting-edge", "world-class", flattery of any kind.
- Em dashes anywhere in the output.
- A greeting ("Hi", "Hello", or a name).
- Wrapping quotes around the hook.

LENGTH & SHAPE:
- Write EXACTLY ONE sentence. Total length under 40 words.
- Do NOT add a second sentence about our thesis, portfolio, adjacencies, or what we are building. The opener stands alone.
- Tone: respectful, founder-to-founder, no sales jargon.

INPUTS:
${anchorsBlock}${discontinuedBlock}${oldProductsBlock}${productsBlock}${foundingYearBlock}
CURRENT WEBSITE COPY:
${currentText.slice(0, 2500)}
Return only the hook text. No commentary.`,
      },
    ],
  });

  let result = resp.content[0].text.trim();
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1).trim();
  }
  result = result.replace(/\s*—\s*/g, ", ");
  return result;
}

/**
 * Find the matching group file key for a sub-vertical display name.
 * E.g. "Bulk Materials" → "Construction and Diversified Materials/bulk-materials.md"
 * Works with both the new folder layout and legacy root-level files.
 */
export function findGroupFileName(
  displayGroupName: string,
  groups: Record<string, string>
): string | null {
  const normalized = displayGroupName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .trim();

  // Direct match (legacy root-level file)
  const direct = normalized + ".md";
  if (direct in groups) return direct;

  // Match against the filename part of each key (ignoring the folder)
  for (const key of Object.keys(groups)) {
    const base = splitGroupKey(key).fileName.toLowerCase();
    if (base.replace(".md", "") === normalized || base.includes(normalized)) {
      return key;
    }
  }

  // Last resort: substring match against the whole key (folder included)
  for (const key of Object.keys(groups)) {
    if (key.toLowerCase().includes(normalized)) return key;
  }
  return null;
}
