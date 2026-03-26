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
  portfolioMatch: { matched: boolean; group: string | null };
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
      `http://web.archive.org/cdx/search/cdx` +
      `?url=${domain}&output=json&limit=1` +
      `&filter=statuscode:200&fl=timestamp`;

    const res = await fetch(cdxUrl, { signal: AbortSignal.timeout(20000) });
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

/**
 * Query Wayback Machine CDX API for snapshots between fromDate and toDate.
 * Returns a list of (archive_url, timestamp) sorted oldest first.
 */
export async function getWaybackCandidates(
  url: string,
  fromDate: string,
  toDate: string
): Promise<WaybackCandidate[]> {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const domain = parsed.hostname;

    const cdxUrl =
      `http://web.archive.org/cdx/search/cdx` +
      `?url=${domain}&output=json` +
      `&from=${fromDate}&to=${toDate}` +
      `&limit=15&filter=statuscode:200` +
      `&collapse=timestamp:4&fl=timestamp,original`;

    const res = await fetch(cdxUrl, { signal: AbortSignal.timeout(30000) });
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
      `http://web.archive.org/cdx/search/cdx` +
      `?url=${domain}/${keyword}*&matchType=prefix&output=json` +
      `&from=${fromDate}&to=${toDate}` +
      `&limit=${limit}&filter=statuscode:200` +
      `&collapse=timestamp:4` +
      `&fl=timestamp,original`;

    const res = await fetch(cdxUrl, { signal: AbortSignal.timeout(15000) });
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
 * Extract company address using Claude + web search.
 * Tries scraped text first, then falls back to web search.
 */
export async function extractAddress(
  client: Anthropic,
  currentText: string,
  url: string
): Promise<string | null> {
  // Attempt 1: Extract from already-scraped text
  const fromText = await askClaudeForAddress(client, currentText);
  if (fromText) return fromText;

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
          content: `Find the headquarters street address for the company whose website is ${domain}.

Search for "${domain} headquarters address" or "${domain} contact address".

ONLY return an address that clearly belongs to this specific company.
Return the full street address as a single line (e.g. '123 Main St, Denver, CO 80202').
If no street address is found, return just the city and state/country (e.g. 'Reno, NV').
If you cannot find any location, return exactly: null`,
        },
      ],
    });

    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length > 0) {
      const raw = textBlocks[textBlocks.length - 1].text.trim();
      if (
        raw.toLowerCase() !== "null" &&
        raw.toLowerCase() !== "none" &&
        raw.length > 4
      ) {
        return raw;
      }
    }
  } catch {
    // Non-critical
  }

  return null;
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
        content: `Extract the company's HEADQUARTERS or main office street address from this text.
If multiple addresses appear, use these priority rules:
1. An address explicitly labeled 'headquarters', 'HQ', 'corporate office', or 'main office'
2. The address associated with the company's home city or founding location
3. If no label distinguishes them, return the first address listed

Return only the full street address as a single line (e.g. '123 Main St, Denver, CO 80202').
Do not include P.O. boxes or branch office addresses when a headquarters is identifiable.
If no street address is present, return exactly: null

Text:
${text.slice(0, 4000)}`,
      },
    ],
  });

  const raw = resp.content[0].text.trim();
  if (
    raw.toLowerCase() === "null" ||
    raw.toLowerCase() === "none" ||
    raw.toLowerCase() === "n/a"
  ) {
    return null;
  }
  // Sanity check: must look like an address (has a digit and reasonable length)
  if (/\d/.test(raw) && raw.length > 10) return raw;
  return null;
}

// ---------------------------------------------------------------------------
// Restaurant Recommendations
// ---------------------------------------------------------------------------

/**
 * Find 3 business dinner restaurants near the address using Claude web search.
 */
export async function findRestaurants(
  client: Anthropic,
  address: string
): Promise<{ name: string; description: string }[]> {
  if (!address) return [];

  // Extract city/state from the address for a better search
  const parts = address.split(",").map((p) => p.trim());
  const cityState =
    parts.length >= 2
      ? parts
          .slice(-2)
          .join(", ")
          .replace(/\s+\d{5}(-\d{4})?$/, "")
          .trim()
      : address;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  ];

  try {
    const resp = await callClaude(client, 2, {
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      tools,
      messages: [
        {
          role: "user",
          content: `Search for fine dining or upscale restaurants near ${cityState} that are suitable for a professional business dinner.

Find 3 real, well-known restaurants. Prefer established restaurants — fine dining, upscale gastropubs, or hotel restaurants with private dining.

Return a JSON array of exactly 3 objects. Each object must have:
  "name": the actual restaurant name
  "description": one sentence on why it suits a business dinner

No commentary, no markdown, no explanation — only the JSON array.
If you cannot find real restaurants for this location, return an empty array: []`,
        },
      ],
    });

    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length === 0) return [];
    const raw = textBlocks[textBlocks.length - 1].text.trim();

    return parseRestaurantJson(raw);
  } catch {
    return [];
  }
}

function parseRestaurantJson(
  raw: string
): { name: string; description: string }[] {
  const BAD_SIGNALS = [
    "no suitable",
    "not found",
    "no restaurant",
    "cannot",
    "unable",
  ];

  function isReal(r: { name: string }): boolean {
    const name = r.name.toLowerCase().trim();
    if (!name) return false;
    return !BAD_SIGNALS.some((sig) => name.includes(sig));
  }

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (r) => typeof r === "object" && r.name && isReal(r)
        )
        .map((r) => ({ name: r.name, description: r.description || "" }))
        .slice(0, 3);
    }
  } catch {
    // Try extracting JSON array from prose
  }

  const match = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (r) => typeof r === "object" && r.name && isReal(r)
          )
          .map((r) => ({ name: r.name, description: r.description || "" }))
          .slice(0, 3);
      }
    } catch {
      // Parse failure
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Portfolio Matching
// ---------------------------------------------------------------------------

/**
 * Load all portfolio group .md files from content/groups/.
 * Returns { filename: content } map.
 */
export function loadGroupFiles(): Record<string, string> {
  const groupsDir = path.join(process.cwd(), "content", "groups");
  const groups: Record<string, string> = {};

  try {
    const files = fs.readdirSync(groupsDir).filter(
      (f) => f.endsWith(".md") && f.toUpperCase() !== "CLAUDE.MD"
    );
    for (const file of files) {
      groups[file] = fs.readFileSync(path.join(groupsDir, file), "utf-8");
    }
  } catch {
    // Directory not found or read error
  }

  return groups;
}

/**
 * Ask Claude to classify the company into the best-fit portfolio group.
 */
export async function matchGroup(
  client: Anthropic,
  currentText: string,
  groups: Record<string, string>
): Promise<{ matched: boolean; group: string | null }> {
  if (Object.keys(groups).length === 0) {
    return { matched: false, group: null };
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

COMPANY WEBSITE:
${currentText.slice(0, 8000)}

GROUP FILES:
${summaries}

If the company is a clear fit for one of the groups, return only the exact filename (e.g. mining.md).
If none of the groups are a reasonable fit, return exactly: NO_MATCH
No explanation.`,
      },
    ],
  });

  const raw = resp.content[0].text.trim().replace(/['"]/g, "");

  if (raw.toUpperCase() === "NO_MATCH") {
    return { matched: false, group: null };
  }

  // Resolve the matched filename
  const resolvedFile = resolveMatchedFile(raw, groups);
  const groupName = displayName(resolvedFile);

  return { matched: true, group: groupName };
}

function resolveMatchedFile(
  matched: string,
  groups: Record<string, string>
): string {
  if (matched in groups) return matched;
  const lower = matched.toLowerCase();
  for (const fname of Object.keys(groups)) {
    if (
      lower.includes(fname.toLowerCase()) ||
      fname.toLowerCase().replace(".md", "").includes(lower.replace(".md", ""))
    ) {
      return fname;
    }
  }
  return Object.keys(groups)[0];
}

/** Convert 'bulk-materials.md' → 'Bulk Materials' */
function displayName(filename: string): string {
  return filename
    .replace(".md", "")
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

/**
 * Find the matching group file name for a group display name.
 * E.g. "Bulk Materials" → "bulk-materials.md"
 */
export function findGroupFileName(
  displayGroupName: string,
  groups: Record<string, string>
): string | null {
  const normalized = displayGroupName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .trim();

  // Direct match
  const direct = normalized + ".md";
  if (direct in groups) return direct;

  // Fuzzy match
  for (const fname of Object.keys(groups)) {
    if (
      fname.toLowerCase().replace(".md", "") === normalized ||
      fname.toLowerCase().includes(normalized)
    ) {
      return fname;
    }
  }
  return null;
}
