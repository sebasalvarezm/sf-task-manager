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
import { getCachedSnapshot, putCachedSnapshot } from "./wayback-cache";

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

const WAYBACK_SNAPSHOT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

// Archive.org runs the CDX/Availability index and the archived-page playback
// service under separate, very different rate limits. The index tolerates the
// pace below; playback is far stricter and answers 429 long before the index
// complains, so the two run on independent paced lanes.
const WAYBACK_INDEX_MIN_GAP_MS = 400;
const WAYBACK_PLAYBACK_MIN_GAP_MS = 4_000;
const WAYBACK_MAX_ATTEMPTS = 3;
const WAYBACK_RETRY_BASE_MS = 750;
const WAYBACK_RETRYABLE_STATUSES = new Set([
  408, 425, 429, 498, 500, 502, 503, 504,
]);
/** Used when Archive.org answers 429 without a Retry-After header. */
const WAYBACK_DEFAULT_COOLDOWN_MS = 30_000;
/** Never sit on a single cooldown longer than this, whatever Retry-After says. */
const WAYBACK_MAX_COOLDOWN_MS = 60_000;

type WaybackLane = "index" | "playback";

type WaybackRequestFailure = "timeout" | "http_error" | "network_error";

type WaybackTextResponse =
  | { ok: true; body: string; status: number; attempts: number }
  | {
      ok: false;
      failure: WaybackRequestFailure;
      status: number | null;
      attempts: number;
    };

type WaybackLaneState = { queue: Promise<void>; nextRequestAt: number; gapMs: number };

const waybackLanes: Record<WaybackLane, WaybackLaneState> = {
  index: { queue: Promise.resolve(), nextRequestAt: 0, gapMs: WAYBACK_INDEX_MIN_GAP_MS },
  playback: { queue: Promise.resolve(), nextRequestAt: 0, gapMs: WAYBACK_PLAYBACK_MIN_GAP_MS },
};

/**
 * Set whenever playback answers 429. Shared across the whole process so one
 * throttle pauses every archived-page download, including other companies in a
 * bulk batch, instead of each snapshot rediscovering the block in turn.
 */
let waybackPlaybackCooldownUntil = 0;

/**
 * Consecutive connection-level playback failures. One is a blip; two in a row
 * means the host is refusing connections, which during an Archive.org outage is
 * the dominant failure mode and needs the same patience as a 503.
 */
let waybackPlaybackConnectionFailures = 0;
const WAYBACK_CONNECTION_FAILURE_COOLDOWN_MS = 20_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is either a number of seconds or an HTTP date. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, WAYBACK_MAX_COOLDOWN_MS);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.min(Math.max(0, parsedDate - Date.now()), WAYBACK_MAX_COOLDOWN_MS);
  }
  return null;
}

function enqueueWaybackRequest<T>(
  request: () => Promise<T>,
  lane: WaybackLane,
): Promise<T> {
  // Pace request starts without holding the queue for the entire network
  // response. Bulk sourcing can therefore make limited forward progress (at
  // most one in-flight request per company) without recreating the old burst.
  const state = waybackLanes[lane];
  const ready = state.queue.then(async () => {
    const remaining = state.nextRequestAt - Date.now();
    if (remaining > 0) await wait(remaining);
    state.nextRequestAt = Date.now() + state.gapMs;
  });
  state.queue = ready.then(
    () => undefined,
    () => undefined,
  );
  return ready.then(request);
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function fetchWaybackText(
  url: string,
  options: {
    timeoutMs: number;
    headers?: Record<string, string>;
    maxAttempts?: number;
    lane?: WaybackLane;
    /** Wall-clock time after which waiting out a cooldown is abandoned. */
    deadlineAt?: number;
  },
): Promise<WaybackTextResponse> {
  const maxAttempts = options.maxAttempts ?? WAYBACK_MAX_ATTEMPTS;
  const lane = options.lane ?? "index";
  let lastFailure: WaybackTextResponse = {
    ok: false,
    failure: "network_error",
    status: null,
    attempts: 0,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (lane === "playback") {
      // Archive.org asked for quiet. Wait it out rather than spending this
      // attempt on a request that is certain to come back 429.
      const cooldownRemaining = waybackPlaybackCooldownUntil - Date.now();
      if (cooldownRemaining > 0) {
        if (options.deadlineAt && Date.now() + cooldownRemaining > options.deadlineAt) {
          return lastFailure.attempts > 0
            ? lastFailure
            : { ok: false, failure: "http_error", status: 429, attempts: attempt - 1 };
        }
        await wait(cooldownRemaining);
      }
    }

    const result = await enqueueWaybackRequest(async (): Promise<WaybackTextResponse> => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(options.timeoutMs),
          headers: options.headers ?? WAYBACK_HEADERS,
          redirect: "follow",
        });
        const body = await response.text();
        if (response.ok) {
          return { ok: true, body, status: response.status, attempts: attempt };
        }
        // 429 is throttling; 503 is Archive.org's "temporarily offline" page.
        // Both mean stop asking for a while, not retry in a second.
        if ((response.status === 429 || response.status === 503) && lane === "playback") {
          const cooldown =
            parseRetryAfterMs(response.headers.get("retry-after")) ??
            WAYBACK_DEFAULT_COOLDOWN_MS;
          waybackPlaybackCooldownUntil = Math.max(
            waybackPlaybackCooldownUntil,
            Date.now() + cooldown,
          );
        }
        return {
          ok: false,
          failure: "http_error",
          status: response.status,
          attempts: attempt,
        };
      } catch (error) {
        return {
          ok: false,
          failure: isTimeoutError(error) ? "timeout" : "network_error",
          status: null,
          attempts: attempt,
        };
      }
    }, lane);

    if (lane === "playback") {
      if (result.ok) {
        waybackPlaybackConnectionFailures = 0;
      } else if (result.failure === "network_error" || result.failure === "timeout") {
        waybackPlaybackConnectionFailures++;
        if (waybackPlaybackConnectionFailures >= 2) {
          waybackPlaybackCooldownUntil = Math.max(
            waybackPlaybackCooldownUntil,
            Date.now() + WAYBACK_CONNECTION_FAILURE_COOLDOWN_MS,
          );
        }
      }
    }

    if (result.ok) return result;
    lastFailure = result;

    const retryable =
      result.failure !== "http_error" ||
      (result.status !== null && WAYBACK_RETRYABLE_STATUSES.has(result.status));
    if (!retryable || attempt === maxAttempts) break;

    // When a shared cooldown is now in force the next loop waits on it, so an
    // extra exponential backoff on top would only shorten the retry budget.
    const cooldownActive =
      lane === "playback" && waybackPlaybackCooldownUntil > Date.now();
    if (!cooldownActive) {
      const backoff =
        WAYBACK_RETRY_BASE_MS * 2 ** (attempt - 1) +
        Math.floor(Math.random() * 250);
      await wait(backoff);
    }
  }

  return lastFailure;
}

/** Milliseconds the shared playback cooldown still has to run, for logging. */
export function waybackPlaybackCooldownRemainingMs(): number {
  return Math.max(0, waybackPlaybackCooldownUntil - Date.now());
}

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
  maxChars = 8000,
  deadlineAt?: number
): Promise<{
  text: string | null;
  failure: WaybackRequestFailure | null;
  status: number | null;
  attempts: number;
}> {
  const fetched = await fetchWaybackText(url, {
    timeoutMs,
    headers: WAYBACK_SNAPSHOT_HEADERS,
    lane: "playback",
    deadlineAt,
  });
  if (!fetched.ok) {
    return {
      text: null,
      failure: fetched.failure,
      status: fetched.status,
      attempts: fetched.attempts,
    };
  }

  try {
    let html = fetched.body;
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
    return {
      text: text.slice(0, maxChars) || null,
      failure: null,
      status: fetched.status,
      attempts: fetched.attempts,
    };
  } catch {
    return {
      text: null,
      failure: "network_error",
      status: fetched.status,
      attempts: fetched.attempts,
    };
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

  // Crawl sub-pages in parallel, preserving the configured priority order when
  // assembling the capped text.
  const subpages = await Promise.all(
    CRAWL_PATHS.map((p) => fetchPageText(base + p, 8000)),
  );
  for (let i = 0; i < CRAWL_PATHS.length; i++) {
    if (total >= maxTotalChars) break;
    const text = subpages[i];
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
async function callClaude(
  client: Anthropic,
  maxRetries = 2,
  opts: any,
  // Per-request overrides such as `timeout`. The SDK default is 10 minutes,
  // which is longer than the platform allows a whole sourcing run to take, so
  // any call inside a time-boxed stage should set its own ceiling.
  requestOptions?: { timeout?: number }
): Promise<any> {
  const RETRYABLE = [500, 503, 529];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(opts, requestOptions);
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

    const response = await fetchWaybackText(cdxUrl, {
      headers: WAYBACK_HEADERS,
      // CDX regularly takes 25s+ when Archive.org is busy. A tighter limit here
      // silently drops the archive-based founding year on healthy responses.
      timeoutMs: 30000,
    });
    if (!response.ok) return null;
    const data = JSON.parse(response.body);

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
  | "fallback_used"
  | "snapshot_timeout"
  | "snapshot_http_error"
  | "snapshot_network_error";

export type WaybackLookupResult = {
  candidates: WaybackCandidate[];
  status: WaybackStatus;
  /**
   * Why the primary CDX lookup produced nothing, retained even when the
   * Availability fallback then succeeds. Without it a CDX timeout is
   * indistinguishable from "this domain has no archived snapshots".
   */
  primaryFailure: WaybackStatus | null;
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
  toDate: string,
  timeoutMs = 45000
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

    const response = await fetchWaybackText(cdxUrl, {
      headers: WAYBACK_HEADERS,
      timeoutMs,
    });
    if (!response.ok) {
      primaryStatus = response.failure;
    } else {
      const data = JSON.parse(response.body);
      if (data.length < 2) {
        primaryStatus = "empty";
      } else {
        const candidates = data.slice(1).map((row: string[]) => ({
          url: `https://web.archive.org/web/${row[0]}/${row[1]}`,
          timestamp: row[0],
        }));
        return { candidates, status: "ok", primaryFailure: null };
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
      // Keep why CDX produced nothing. A timeout here means the snapshot list
      // is incomplete, which is very different from the domain having none.
      return {
        candidates: [fallback],
        status: "fallback_used",
        primaryFailure: primaryStatus,
      };
    }
  }

  return { candidates: [], status: primaryStatus, primaryFailure: primaryStatus };
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
    const response = await fetchWaybackText(
      `https://archive.org/wayback/available?${params.toString()}`,
      {
        headers: WAYBACK_HEADERS,
        timeoutMs: 15000,
      }
    );
    if (!response.ok) return null;
    const data = JSON.parse(response.body);
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
export type WaybackSnapshotFailure =
  | "too_little_content"
  | "parked_page"
  | "prior_owner"
  | "timeout"
  | "http_error"
  | "network_error";

export type WaybackSnapshotResult = {
  text: string | null;
  skipReason: string | null;
  failureType: WaybackSnapshotFailure | null;
  httpStatus: number | null;
  attempts: number;
  /** True when the result was served from the snapshot cache. */
  cached?: boolean;
};

/** Verdicts that are permanent properties of a snapshot, so safe to cache. */
const CACHEABLE_FAILURES = new Set<WaybackSnapshotFailure>([
  "too_little_content",
  "parked_page",
  "prior_owner",
]);

export async function fetchWaybackSnapshot(
  archiveUrl: string,
  domainStem: string,
  deadlineAt?: number
): Promise<WaybackSnapshotResult> {
  const secureArchiveUrl = archiveUrl.replace(/^http:/i, "https:");

  // An archived page never changes, so a stored copy is always still correct.
  const cached = await getCachedSnapshot(secureArchiveUrl);
  if (cached) {
    return {
      text: cached.text,
      skipReason: cached.skipReason,
      failureType: (cached.failureType as WaybackSnapshotFailure | null) ?? null,
      httpStatus: 200,
      attempts: 0,
      cached: true,
    };
  }

  // Archive.org playback has been observed succeeding at ~30s when their
  // service is loaded, so a 20s cut-off discarded pages that were on their way.
  const fetched = await fetchRawText(secureArchiveUrl, 30000, 8000, deadlineAt);
  if (fetched.failure) {
    const statusDetail = fetched.status ? ` HTTP ${fetched.status}` : "";
    const attemptDetail = fetched.attempts > 1
      ? ` after ${fetched.attempts} attempts`
      : "";
    const label = fetched.failure === "timeout"
      ? "Wayback snapshot timed out"
      : fetched.failure === "http_error"
        ? `Wayback snapshot returned${statusDetail}`
        : "Wayback snapshot request failed";
    return {
      text: null,
      skipReason: `${label}${attemptDetail}`,
      failureType: fetched.failure,
      httpStatus: fetched.status,
      attempts: fetched.attempts,
    };
  }

  const text = fetched.text;
  const verdict = ((): Pick<WaybackSnapshotResult, "text" | "skipReason" | "failureType"> => {
    if (!text || text.length < 300) {
      return { text: null, skipReason: "too little content", failureType: "too_little_content" };
    }
    if (isParkedPage(text)) {
      return {
        text: null,
        skipReason: "looks like a parked domain page",
        failureType: "parked_page",
      };
    }
    // Check for domain stem — also try without spaces/hyphens (matches Python version)
    const textLower = text.toLowerCase();
    const stemLower = domainStem.toLowerCase();
    const textNoSpace = textLower.replace(/[\s\-_]/g, "");
    if (!textLower.includes(stemLower) && !textNoSpace.includes(stemLower)) {
      return {
        text: null,
        skipReason: "company name not found (likely a prior domain owner)",
        failureType: "prior_owner",
      };
    }
    return { text, skipReason: null, failureType: null };
  })();

  // Only permanent verdicts reach here — transport failures returned above and
  // are never cached, because they have to be retried later.
  if (verdict.failureType === null || CACHEABLE_FAILURES.has(verdict.failureType)) {
    await putCachedSnapshot(secureArchiveUrl, {
      text: verdict.text,
      skipReason: verdict.skipReason,
      failureType: verdict.failureType,
    });
  }

  return {
    ...verdict,
    httpStatus: fetched.status,
    attempts: fetched.attempts,
  };
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

    const response = await fetchWaybackText(cdxUrl, {
      headers: WAYBACK_HEADERS,
      timeoutMs: 30000,
    });
    if (!response.ok) return [];
    const data = JSON.parse(response.body);

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

Find ONE product or service from the OLD list whose absence from the current site is CLEAR. Any of these counts as clear:
- The exact name is gone and no current item plausibly covers it
- An old branded name was replaced with a generic description
- A product category or capability was dropped entirely

Do NOT count these as discontinued:
- A product that was simply renamed, where a current item clearly does the same job
- A service line that was folded into a broader current offering
- A generic category like "consulting", "support", "training", or "integrations"
- Anything where you are guessing. A wrong discontinuation is worse than none, because it goes into a cold email as a statement of fact.

If no product's absence is clear, return exactly: none

Return only the product/service name from the OLD list, or "none". No explanation.`,
      },
    ],
  });

  const raw = resp.content[0].text.trim();
  // The model is now allowed to decline, so accept every shape of "no" it may
  // answer with ("none", "None.", "none — nothing is clearly gone").
  if (/^none\b/i.test(raw) || raw.length > 200) return null;
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
  return collectCitationUrls(resp)[0] ?? null;
}

/**
 * Collect every real http(s) URL Claude's web search actually returned, walking
 * both `web_search_tool_result` blocks and the `citations` arrays on text
 * blocks. Also descends into nested result blocks, which is where results land
 * when the newer search tool filters them inside code execution.
 *
 * Used to verify that a URL a model *claims* as its source is one the search
 * genuinely returned — a model-written URL on its own proves nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectCitationUrls(resp: any): string[] {
  const isHttp = (u: unknown): u is string =>
    typeof u === "string" && /^https?:\/\//i.test(u);
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown) => {
    if (!isHttp(u) || seen.has(u)) return;
    seen.add(u);
    found.push(u);
  };

  // The block shapes are loosely typed and nest differently across tool
  // versions, so walk the whole structure defensively rather than assuming one
  // layout. Depth-capped so a malformed response can never spin.
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if ("url" in record) push(record.url);
    for (const key of ["content", "citations", "results"]) {
      if (key in record) walk(record[key], depth + 1);
    }
  };

  walk(resp?.content, 0);
  return found;
}

/** Hostname of a URL, lowercased and without "www.". Null when unparseable. */
function urlHost(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
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

// Longest form first: regex alternation takes the first match, so "Corp" ahead
// of "Corporation" would truncate the name.
const COMPANY_LEGAL_SUFFIX =
  "(?:Incorporated|Corporation|Holdings|Limited|Company|GmbH|Group|SARL|Corp|Inc|Ltd|LLC|PLC|Pty|SAS|SpA|SRL|AB|AG|AS|BV|NV|Oy|SA)";

/**
 * Pull the company's real registered name out of the scraped page.
 *
 * The domain stem is not the company name. "fast-soft.com" belongs to FasTrak
 * SoftWorks, and searching the web for "Fast-soft" finds whichever unrelated
 * company happens to share that string — which is how a Wisconsin manufacturer
 * acquired an address in Saint Petersburg. A copyright or legal footer line is
 * the most reliable place the true name appears, so read it before guessing.
 */
export function extractCompanyNameFromText(text: string): string | null {
  if (!text) return null;
  const namePattern = `([A-Z][A-Za-z0-9&.'\\-]*(?:[ ][A-Z][A-Za-z0-9&.'\\-]*){0,4}[, ]+${COMPANY_LEGAL_SUFFIX}\\.?)`;
  // Deliberately no "i" flag: the name capture must stay case-sensitive so it
  // cannot start mid-sentence on a lowercase word. Literal keywords therefore
  // spell out their own casing.
  const patterns = [
    // "© 2025 FasTrak SoftWorks, Inc." — strongest signal.
    new RegExp(
      `(?:©|&copy;|\\(c\\)|[Cc]opyright|COPYRIGHT)\\s*(?:\\d{4})?\\s*(?:[-–]\\s*\\d{4})?\\s*,?\\s*${namePattern}`,
    ),
    // "All rights reserved" lines often carry the name just before them.
    new RegExp(`${namePattern}[^.]{0,40}[Aa]ll [Rr]ights [Rr]eserved`),
    // Bare legal name anywhere in the page as a last resort.
    new RegExp(namePattern),
  ];
  for (const [index, pattern] of patterns.entries()) {
    // The bare-name pattern is a last resort and would happily match a customer
    // or partner named mid-page, so restrict it to the footer region where a
    // site states its own legal name.
    const haystack = index === patterns.length - 1 ? text.slice(-1500) : text;
    const match = haystack.match(pattern);
    const name = match?.[1]?.replace(/\s+/g, " ").trim().replace(/[,.]$/, "");
    // Two characters of "name" before a suffix is noise, not a company.
    if (name && name.length >= 5 && name.length <= 70) return name;
  }
  return null;
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
  companyName?: string,
  options?: { allowWebSearch?: boolean },
): Promise<AddressResolution> {
  // Attempt 1: Prefer an explicit postal address already present in the
  // website scrape. This avoids losing a clear contact/footer address to an
  // AI extraction miss (for example: "NO-4460 Moi, Norway").
  const explicitAddress = extractExplicitAddressFromText(currentText);
  if (explicitAddress) {
    return {
      address: explicitAddress,
      source: "company website",
      sourceUrl: url.startsWith("http") ? url : `https://${url}`,
      confidence: addressConfidence(explicitAddress),
    };
  }

  // Attempt 2: Extract from already-scraped text with AI when no explicit
  // postal/contact line could be identified deterministically.
  const fromText = await askClaudeForAddress(client, currentText);
  if (fromText) {
    return {
      address: fromText,
      source: "company website",
      sourceUrl: url.startsWith("http") ? url : `https://${url}`,
      confidence: addressConfidence(fromText),
    };
  }

  if (options?.allowWebSearch === false) {
    return { address: null, source: null, sourceUrl: null, confidence: "none" };
  }

  // Attempt 3: Use Claude web search to find the headquarters address
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

  // Attempt 4: Web search by COMPANY NAME (city-level is acceptable).
  // This is the fallback when the site has no address and the domain search
  // came up empty — e.g. "<name> software headquarters address".
  const name = companyName || quickCompanyName(url);
  const nameSearchDomain = (() => {
    try {
      return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(
        /^www\./,
        "",
      );
    } catch {
      return "";
    }
  })();
  if (name && nameSearchDomain) {
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
            content: `Find where a company is based. The company is identified by its WEBSITE, not by its name:

Website: ${nameSearchDomain}
Name it appears to use: "${name}"

Try searches like "${name} headquarters address", "${nameSearchDomain} head office", "${name} company location", and "${name} contact".

CRITICAL: unrelated companies often share a similar name in other countries. The location you return must belong to the company that operates ${nameSearchDomain}. If the pages you find describe a different company that merely has a similar name, return null instead of guessing.

Return ONLY a JSON object, no commentary:
{"location": "<full street address, or city + state/country>", "website": "<the official domain of the company that location belongs to>"}

- Best case location: '123 Main St, Denver, CO 80202'. City + state/country alone is fine: 'Reno, NV' or 'Toronto, ON'.
- "website" must be the domain you actually saw associated with that location, so it can be checked against ${nameSearchDomain}.
- If you cannot confirm a location for the company operating ${nameSearchDomain}, return: {"location": null, "website": null}`,
          },
        ],
      });

      const textBlocks = resp.content.filter(
        (b: { type: string }) => b.type === "text"
      );
      if (textBlocks.length > 0) {
        const raw = textBlocks[textBlocks.length - 1].text.trim();
        const parsedAnswer = (() => {
          try {
            return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as {
              location?: string | null;
              website?: string | null;
            };
          } catch {
            // Older behaviour: a bare address line rather than JSON.
            return { location: raw, website: null };
          }
        })();
        const validated = parsedAnswer.location
          ? validateAddress(String(parsedAnswer.location))
          : null;
        // The search was by name, so confirm the answer belongs to OUR domain.
        // A same-named company elsewhere is the exact failure this guards.
        const answerDomain = normalizeAddressDomain(parsedAnswer.website);
        const ourDomain = normalizeAddressDomain(nameSearchDomain);
        const domainConflict =
          Boolean(answerDomain) &&
          Boolean(ourDomain) &&
          answerDomain !== ourDomain &&
          !answerDomain.endsWith(`.${ourDomain}`) &&
          !ourDomain.endsWith(`.${answerDomain}`);
        if (validated && !domainConflict) {
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

/** Bare registrable host for comparing a search answer against our website. */
function normalizeAddressDomain(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];
}

/**
 * Pull an address directly from contact/footer text before asking AI. Website
 * scrapes commonly expose a full postal line next to Office, Headquarters, or
 * Contact; country-prefixed postal codes are particularly strong evidence.
 */
export function extractExplicitAddressFromText(text: string): string | null {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}|[-*•])\s*/, "")
        .replace(/^\s*>\s*/, "")
        .trim(),
    )
    .filter(Boolean);

  const looksPostal = (line: string) => {
    if (/https?:\/\/|@|\b(?:phone|tel|fax|e-?mail)\b/i.test(line)) return false;
    if (!/\d/.test(line) || !/,/.test(line)) return false;
    return (
      /\b[A-Z]{2}[-\s]?\d{4,6}\b/i.test(line) ||
      /\b\d{4,6}\s+[A-Za-zÀ-ÖØ-öø-ÿ][^,]*,\s*[A-Za-zÀ-ÖØ-öø-ÿ ]+$/i.test(line) ||
      /\b(?:Norway|Norge|Netherlands|Nederland|United Kingdom|Canada|Australia|Germany|France|Belgium|Sweden|Denmark|Finland)\b/i.test(line)
    );
  };

  // Strongest signal first: an explicit international postal/country line.
  for (const line of lines) {
    if (looksPostal(line)) {
      const validated = validateAddress(line);
      if (validated) return validated;
    }
  }

  // Then inspect the lines immediately following a contact-location heading.
  for (let index = 0; index < lines.length; index++) {
    if (!/^(?:office|headquarters|hq|main office|address|contact(?: us)?)\s*:?​?$/i.test(lines[index])) {
      continue;
    }
    for (const candidate of lines.slice(index + 1, index + 5)) {
      if (!looksPostal(candidate)) continue;
      const validated = validateAddress(candidate);
      if (validated) return validated;
    }
  }
  return null;
}

async function askClaudeForAddress(
  client: Anthropic,
  text: string
): Promise<string | null> {
  if (!text || text.length < 100) return null;

  // Addresses are commonly in the contact/footer area, beyond the first few
  // thousand characters. Keep the prompt compact but include both the start
  // and end of the scrape so the legal office address is not missed.
  const addressEvidence =
    text.length <= 4000
      ? text
      : `${text.slice(0, 1500)}\n\n[CONTACT / FOOTER AREA]\n${text.slice(-2500)}`;

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
${addressEvidence}`,
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
  warning?: string | null;
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
    if (!resolvedFile) {
      return {
        matched: false,
        group: null,
        mainGroup: null,
        confidence: parsed.confidence ?? null,
        warning: `AI returned an unknown group file: ${parsed.file}`,
      };
    }
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
    if (!resolvedFile) {
      return {
        matched: false,
        group: null,
        mainGroup: null,
        confidence: null,
        warning: `AI returned an unknown group: ${text}`,
      };
    }
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
): string | null {
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
  return null;
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
    | "formation_event" // formed by a merger/acquisition/spin-out
    | "release_trail" // the one real launch among annual version bumps
    | "registry_artifact" // Companies House number, App Store listing, etc.
    | "own_timeline" // the company's own history/milestones page
    | "distinctive_moment" // rebrand, acquisition, founder anecdote
    | "obscure_trivia" // weird artifact from old snapshots
    | "early_niche"; // a specific named customer segment they pioneered
  anchor: string; // exact phrase to slot after "going back to"
  evidence: string; // 1 sentence: where this came from
  /** Real page the claim came from. Null only on the legacy hinted path. */
  sourceUrl?: string | null;
  /** Human-readable provenance, e.g. "PitchBook \"formerly known as\" field". */
  sourceLabel?: string | null;
  /** Year of the event, when one is genuinely established. */
  year?: number | null;
  /** How sure we are the FACT is true. */
  factConfidence?: "high" | "medium" | "low";
  /** How sure we are of the YEAR — often lower than the fact itself. */
  dateConfidence?: "high" | "medium" | "low";
  /**
   * How hard this was to find, which is the whole point of a hook. A true fact
   * that sits in the first line of an About page proves no homework was done,
   * so being verifiable is necessary but nowhere near sufficient.
   */
  obviousness?: "front_page" | "few_clicks" | "buried";
};

/**
 * One class of source that historically yields a usable hook, with the searches
 * that actually find it. These are modelled on hand-researched examples: a
 * PitchBook "formerly known as" field, a dated PRWeb release, a company's own
 * "40 Years of Innovation" timeline, a Companies House number in a site footer.
 *
 * Encoding the queries beats telling the model to "research the company's
 * history" — it aims the search budget where the answers actually live.
 */
type ProvenanceClass = {
  type: CompanyAnchor["type"];
  label: string;
  /** What a hit looks like, so the model knows when it has found one. */
  looksLike: string;
  /**
   * `products` holds the names the company sells today. A product name is the
   * strongest search term available for finding old releases — "COMPRESS build
   * history" reaches an actual version trail that a domain-only query never
   * will — so any class that hunts for launches should use them.
   */
  queries: (name: string, domain: string, products: string[]) => string[];
};

/** Round 1 — the three classes that hit most often. */
const PROVENANCE_ROUND_1: ProvenanceClass[] = [
  {
    type: "former_name",
    label: "former name or rebrand",
    looksLike:
      'a prior trading name, predecessor entity, or "formerly known as" record',
    queries: (name) => [
      `"${name}" "formerly known as"`,
      `"${name}" renamed OR rebranded OR "previously known as" OR "originally called"`,
    ],
  },
  {
    type: "own_timeline",
    label: "the company's own history page",
    looksLike:
      'a SPECIFIC dated milestone buried in an "our story", timeline, or "N years of" page — a named product, a move, an award, an odd anecdote. Never the founding sentence at the top of the page',
    queries: (name, domain) => [
      `site:${domain} history OR timeline OR "our story" OR milestones OR anniversary`,
    ],
  },
  {
    type: "product_release",
    label: "dated press release",
    looksLike:
      "a wire-service announcement with a real date and a named product",
    queries: (name, _domain, products) => [
      `"${name}" prweb OR prnewswire OR businesswire announces OR launches OR introduces`,
      ...products
        .slice(0, 2)
        .map((p) => `"${p}" "${name}" announced OR launched OR "first released"`),
    ],
  },
];

/** Round 2 — only runs when round 1 came up dry. */
const PROVENANCE_ROUND_2: ProvenanceClass[] = [
  {
    type: "formation_event",
    label: "formation or M&A event",
    looksLike:
      "the company being formed by a merger, acquisition, or spin-out, with the acquired name",
    queries: (name) => [
      `"${name}" acquired OR merged OR "was formed when" OR "spun out of" OR "series a"`,
    ],
  },
  {
    type: "release_trail",
    label: "version or release-notes trail",
    looksLike:
      "a version history where one entry is a genuinely new product rather than an annual bump, or an early build of a product they still sell",
    queries: (name, domain, products) => [
      `site:${domain} "release notes" OR "what's new" OR "version history" OR changelog`,
      ...products
        .slice(0, 2)
        .flatMap((p) => [
          `"${p}" "release notes" OR "build" OR "version history"`,
          `"${p}" ${name} 2010..2018`,
        ]),
    ],
  },
  {
    type: "registry_artifact",
    label: "registry or app-store artifact",
    looksLike:
      "a company registration number, incorporation date, or an app store listing that dates a product",
    queries: (name) => [
      `"${name}" "Companies House" OR incorporated OR "app store" OR "google play"`,
    ],
  },
];

/**
 * Search tool versions to try, best first.
 *
 * The basic tool leads deliberately. The newer version filters results inside
 * code execution, which is meant to save context, but measured against three
 * searches it was worse on both axes — 49s and 42.3k input tokens versus 20s
 * and 22.7k for the basic tool. Provisioning the sandbox costs more than the
 * filtering saves at this size, and 2.5x the latency does not fit inside a job
 * the platform kills at 300s.
 *
 * The newer version stays as a fallback purely so this keeps working if a
 * future model stops accepting the basic tool.
 */
const HOOK_SEARCH_TOOL_VERSIONS = [
  "web_search_20250305",
  "web_search_20260209",
] as const;

/**
 * Ceiling for one research round. Three searches measured 20s, so this is
 * generous — it exists to stop a stalled round from consuming a run's entire
 * 300s allowance, which is exactly what the SDK's 10-minute default allows.
 * The retry wrapper does not retry timeouts, so a stall fails the round once
 * and the ladder logs it rather than trying again.
 */
const HOOK_SEARCH_TIMEOUT_MS = 90_000;

/**
 * Call Claude with the web search tool, stepping down the tool version if the
 * API rejects the newer one for this model.
 */
async function callClaudeWithWebSearch(
  client: Anthropic,
  maxUses: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  for (let i = 0; i < HOOK_SEARCH_TOOL_VERSIONS.length; i++) {
    const version = HOOK_SEARCH_TOOL_VERSIONS[i];
    const isLast = i === HOOK_SEARCH_TOOL_VERSIONS.length - 1;
    try {
      return await callClaude(
        client,
        2,
        {
          ...opts,
          tools: [{ type: version, name: "web_search", max_uses: maxUses }],
        },
        { timeout: HOOK_SEARCH_TIMEOUT_MS }
      );
    } catch (err) {
      const rejectedToolVersion =
        err instanceof Anthropic.BadRequestError &&
        /web_search|allowed_callers|tool/i.test(err.message);
      if (rejectedToolVersion && !isLast) continue;
      throw err;
    }
  }
}

/** How many web searches a response actually spent, for cost logging. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function webSearchCount(resp: any): number {
  const n = resp?.usage?.server_tool_use?.web_search_requests;
  return typeof n === "number" ? n : 0;
}

/**
 * Pull the first balanced JSON object out of a model response, tolerating code
 * fences and any stray commentary around it. Returns null when there is no
 * parseable object — the caller then knows the call genuinely failed instead of
 * silently treating a parse error as "found nothing".
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const ANCHOR_TYPES = new Set<CompanyAnchor["type"]>([
  "former_name",
  "product_release",
  "formation_event",
  "release_trail",
  "registry_artifact",
  "own_timeline",
  "distinctive_moment",
  "obscure_trivia",
  "early_niche",
]);

function normalizeConfidence(value: unknown): "high" | "medium" | "low" {
  // Default LOW, never high — a missing or garbled confidence must not become a
  // confident claim in a cold email.
  return value === "high" || value === "medium" ? value : "low";
}

function normalizeYear(value: unknown): number | null {
  const n = typeof value === "string" ? parseInt(value, 10) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const currentYear = new Date().getFullYear();
  return n >= 1900 && n <= currentYear ? Math.trunc(n) : null;
}

/**
 * Turn the model's raw anchor JSON into trustworthy anchors.
 *
 * The important work happens here rather than in the prompt: "do not invent" is
 * an instruction a model can fail to follow, whereas a missing or unverifiable
 * source URL is something we can check.
 *
 * - No well-formed http(s) source URL → the anchor is discarded.
 * - `searchUrls` holds the URLs the web search genuinely returned. When we have
 *   them, an anchor citing a host that never appeared is discarded. When the
 *   response carried none (some tool versions filter them out), the anchor is
 *   kept but can rise no higher than medium confidence.
 * - A former-name or formation claim sourced only to the company's own site is
 *   capped at medium: it may well be true, but it is self-reported.
 */
function validateColdAnchors(
  rawAnchors: unknown,
  searchUrls: string[],
  companyHost: string | null
): CompanyAnchor[] {
  if (!Array.isArray(rawAnchors)) return [];
  const searchHosts = new Set(
    searchUrls.map(urlHost).filter((h): h is string => !!h)
  );
  const out: CompanyAnchor[] = [];

  for (const item of rawAnchors) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;

    const anchor = typeof a.anchor === "string" ? a.anchor.trim() : "";
    if (!anchor) continue;
    const type = a.type as CompanyAnchor["type"];
    if (!ANCHOR_TYPES.has(type)) continue;

    // A founding fact is the most findable thing about any company, so as a
    // hook it proves the opposite of homework. Dropped outright, however
    // confidently it is sourced.
    if (isFoundingAnchor(anchor)) continue;

    // Obvious anchors are kept but ranked last, not discarded. Discarding them
    // also threw away app-store listings and registry filings that happen to be
    // public -- the Google Play page dating a product launch is "obvious" and
    // still a better opener than nothing. The founding-fact ban above is the
    // precise instrument for the thing that actually reads as lazy.
    const obviousness =
      a.obviousness === "front_page" || a.obviousness === "buried"
        ? a.obviousness
        : "few_clicks";

    const sourceUrl = typeof a.sourceUrl === "string" ? a.sourceUrl.trim() : "";
    const host = /^https?:\/\//i.test(sourceUrl) ? urlHost(sourceUrl) : null;
    if (!host) continue; // no checkable source, no anchor

    let factConfidence = normalizeConfidence(a.factConfidence);

    if (searchHosts.size > 0) {
      // We know what the search returned, so an unlisted host is a fabrication.
      if (!searchHosts.has(host)) continue;
    } else if (factConfidence === "high") {
      // Nothing to check the URL against — do not let it claim certainty.
      factConfidence = "medium";
    }

    const selfSourced = !!companyHost && host === companyHost;
    if (
      selfSourced &&
      (type === "former_name" || type === "formation_event") &&
      factConfidence === "high"
    ) {
      factConfidence = "medium";
    }

    out.push({
      type,
      anchor,
      evidence: typeof a.evidence === "string" ? a.evidence.trim() : "",
      sourceUrl,
      sourceLabel:
        typeof a.sourceLabel === "string" && a.sourceLabel.trim()
          ? a.sourceLabel.trim()
          : host,
      year: normalizeYear(a.year),
      factConfidence,
      dateConfidence: normalizeConfidence(a.dateConfidence),
      obviousness,
    });
  }

  return rankAnchors(out);
}

/**
 * Strongest facts first, capped at 5. A checkable claim beats a more colourful
 * shaky one, so the hook writer sees the defensible options at the top.
 */
/**
 * Tiebreak order only. Ranked below how buried and how certain an anchor is,
 * because a buried timeline oddity (a scale model in a national museum) makes a
 * far better opener than a predictable former name -- but among equals, a named
 * launch beats "we turned 40".
 */
const TYPE_PRIORITY: Record<CompanyAnchor["type"], number> = {
  former_name: 0,
  product_release: 0,
  release_trail: 0,
  obscure_trivia: 1,
  formation_event: 1,
  distinctive_moment: 2,
  registry_artifact: 2,
  early_niche: 3,
  own_timeline: 4,
};

function rankAnchors(anchors: CompanyAnchor[]): CompanyAnchor[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  // How hard it was to find is weighted alongside how sure we are, because a
  // buried detail that is merely probable makes a better opener than a
  // certainty anyone could have read off the front page.
  const dig = { buried: 0, few_clicks: 1, front_page: 2 } as const;
  // A shaky claim never outranks a solid one, however well buried. Being hard
  // to find only counts among things we actually believe -- the recipient is
  // the one person who can spot an invented former name.
  const shaky = (a: CompanyAnchor) => (a.factConfidence === "low" ? 1 : 0);
  return [...anchors]
    .sort((x, y) => {
      const byTrust = shaky(x) - shaky(y);
      if (byTrust !== 0) return byTrust;
      const byDig =
        dig[x.obviousness ?? "few_clicks"] - dig[y.obviousness ?? "few_clicks"];
      if (byDig !== 0) return byDig;
      const byConf =
        rank[x.factConfidence ?? "low"] - rank[y.factConfidence ?? "low"];
      if (byConf !== 0) return byConf;
      // Last tiebreak: the hierarchy the hook prompt documents. A named product
      // release beats an anniversary when everything else is equal, which is
      // otherwise decided by whichever the model happened to list first.
      return TYPE_PRIORITY[x.type] - TYPE_PRIORITY[y.type];
    })
    .slice(0, 5);
}

/**
 * Does this set of anchors contain something worth stopping the search for?
 *
 * Requires an anchor that is both true AND genuinely buried. Anything easier
 * to find is worth spending the second round to try to beat: stopping on an
 * About-page fact is how the search settles for "the move to a new office"
 * when the release-notes trail held a real product launch. The second round
 * costs three more searches; a weak opener costs the reply.
 */
function hasStrongAnchor(anchors: CompanyAnchor[]): boolean {
  return anchors.some(
    (a) =>
      a.factConfidence === "high" && !!a.sourceUrl && a.obviousness === "buried"
  );
}

/**
 * Anchors that describe a company's founding rather than something it did.
 *
 * The founding year, place, and founder are the most findable facts about any
 * company — first line of the About page, first line of every directory entry.
 * As a hook they actively backfire: they prove the sender looked for five
 * seconds. Detected on the text because a model that has been told not to
 * return one will still occasionally dress it up as a milestone.
 */
const FOUNDING_ANCHOR_PATTERNS = [
  /the founding/i,
  /was founded/i,
  /founding (?:of|in|year|date)/i,
  /(?:its|their|the) (?:incorporation|establishment)/i,
  /when .{0,20}(?:was )?(?:founded|established|incorporated|started out)/i,
  /early days as a (?:startup|new company)/i,
];

function isFoundingAnchor(anchor: string): boolean {
  return FOUNDING_ANCHOR_PATTERNS.some((re) => re.test(anchor));
}

/**
 * Build the cold-research prompt for one round of provenance classes.
 * Deliberately does NOT include the company's website copy — these are searches
 * for historical records, and homepage marketing text only adds tokens.
 */
function buildColdRoundPrompt(
  identity: string,
  companyName: string,
  domain: string,
  classes: ProvenanceClass[],
  alreadyTried: string[],
  products: string[]
): string {
  const searchBlock = classes
    .map((c, i) => {
      const queries = c
        .queries(companyName, domain, products)
        .map((q) => `     ${q}`)
        .join("\n");
      return `${i + 1}. ${c.label.toUpperCase()} — looking for ${c.looksLike}\n   Run:\n${queries}\n   If found, return it as type "${c.type}".`;
    })
    .join("\n\n");

  const triedBlock =
    alreadyTried.length > 0
      ? `\nAlready searched and came up empty, do not repeat: ${alreadyTried.join(", ")}.\n`
      : "";

  return `You are researching a company's history to write one line of a personal cold email. The line reads "I have studied ${companyName} going back to {ANCHOR}." ANCHOR must be a SPECIFIC, VERIFIABLE artifact of the company's past.

${identity}
${triedBlock}
RUN THESE SEARCHES. They are chosen because they are where this kind of record actually lives:

${searchBlock}

THE TEST THAT MATTERS: could a lazy person have found this in five seconds?
If yes, it is worthless no matter how true it is. The hook's entire job is to
prove someone dug. A fact that is easy to find proves the opposite.

WHAT A GOOD ANCHOR LOOKS LIKE (all from real research):
- "the days operating as MyLumper" (a former name, from a "formerly known as" record)
- "the launch of the Field Data Capture app for iPad" (a named product in a dated press release)
- "the release of CSiPlant" (the one genuinely new product among years of version bumps)
- "the days as the software arm of Cleveland Process Designs" (a predecessor entity)
- "the days when the Okappy mascot would appear on the Team page" (odd trivia nobody else would notice)
- "back when you ran free coffee Mondays for the yard crews" (a human detail from an old post)

BANNED — these read as research and are not:
- THE FOUNDING. The year, the city, the founder's name, "was founded in 1983 in
  Ontario under Les Bildy". This is the first line of their About page and every
  directory entry about them. It is the single worst thing you can return. If
  the only thing you can find is when and where they were founded, return an
  EMPTY list instead. An empty list is a useful answer; a founding date is not.
- An anniversary or "N years in business" with no specific event attached.
- Anything a reader could write after five seconds on the homepage.
- A bare year with no event attached.
- A description of what they sell today.
- A claim you did not actually see on a page you searched.

HOW IT MUST READ: the anchor slots straight after "going back to", so it has to
sound like natural speech. Good anchors almost always begin "the days...",
"the release of...", "the launch of...", or "back when...". Read it aloud as a
full sentence before returning it. "going back to the founding in Ontario,
Canada in 1983 under Les M. Bildy" is exactly the clumsy, obvious result to
avoid.

RULES:
- Every anchor MUST carry the real URL of the page you saw it on, in "sourceUrl". No URL means do not return the anchor at all.
- "factConfidence" is how sure you are the FACT is true. "dateConfidence" is how sure you are of the YEAR. These are often different: you may be certain a product exists but unsure when it launched. Say so. Use "low" when you are inferring rather than reading.
- Only set "year" when a page actually states or clearly dates it. Otherwise null.
- Returning an empty list is a correct and useful answer. Inventing a plausible anchor is the worst possible outcome, because it goes into an email as a statement of fact to the person who would know it is wrong.

Return STRICT JSON only, no markdown fences, no commentary:
{
  "companyName": "${companyName}",
  "anchors": [
    {
      "type": "former_name",
      "anchor": "the days operating as MyLumper",
      "sourceUrl": "https://example.com/page-you-actually-saw",
      "sourceLabel": "PitchBook \\"formerly known as\\" field",
      "year": 2019,
      "factConfidence": "high",
      "dateConfidence": "low",
      "obviousness": "buried",
      "evidence": "one short sentence, 25 words maximum: what the page said"
    }
  ]
}

Return at most 3 anchors. Keep every "evidence" under 25 words -- a long answer
gets cut off mid-object and the whole round is thrown away.

"obviousness" is how hard this was to find, and it is judged strictly:
  "front_page" - on the homepage, the About page, or a company directory entry.
                 Ranked last and only ever used when nothing better exists, so
                 label honestly rather than inflating it.
  "few_clicks" - a real page on their site or a news item, but not the first
                 thing anyone would land on.
  "buried"     - an old press release, an archived post, a registry filing, an
                 app listing, a detail inside a long page. This is the target.`;
}

/**
 * Confirm the year of an otherwise-strong anchor by reading its source page.
 *
 * Uses Jina Reader, which is keyless and free per fetch, so this costs one tiny
 * model call and nothing else. Only worth doing when we trust the fact but not
 * the date — the alternative is publishing a year we cannot defend.
 */
async function confirmAnchorYear(
  client: Anthropic,
  anchor: CompanyAnchor
): Promise<CompanyAnchor> {
  if (!anchor.sourceUrl) return anchor;
  const text = await fetchPageText(anchor.sourceUrl, 12000);
  if (!text || text.length < 300) return anchor;

  try {
    const resp = await callClaude(client, 1, {
      model: "claude-sonnet-4-6",
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content: `This page is the source for the claim: "${anchor.anchor}".

Does the page state a specific year for that event? Answer with the 4-digit year alone if the page clearly dates it. If the page does not date it, or you would be inferring, answer exactly: unknown

Page text:
${text.slice(0, 3000)}`,
        },
      ],
    });
    const raw = resp.content[0]?.text?.trim() ?? "";
    const year = normalizeYear(raw.match(/\b(19|20)\d{2}\b/)?.[0]);
    if (year) return { ...anchor, year, dateConfidence: "high" };
  } catch {
    // Non-critical: keep the anchor exactly as it was.
  }
  return anchor;
}

/**
 * Research a company for distinctive, hook-worthy anchors using Claude with
 * web_search. Returns a canonical companyName and up to 5 anchors, strongest
 * first.
 *
 * Two modes:
 *   "hinted" — the Wayback Machine gave us product history, so the search is a
 *     supplement steered by those hints. This is the original behavior.
 *   "cold"  — the archive gave us nothing (it is down, or the domain has no
 *     snapshots). Runs a two-round ladder of targeted searches aimed at the
 *     source types that historically yield a usable hook: former-name records,
 *     the company's own history page, dated press releases, then formation
 *     events, release-notes trails, and registry artifacts. Round 2 only runs
 *     if round 1 found nothing solid, so the common case costs three searches.
 *
 * Failure-tolerant: on any error returns a domain-stem fallback companyName and
 * an empty anchors array, letting generateEmailHook() degrade to a
 * local-data-only hook.
 */
export async function researchCompanyAnchors(
  client: Anthropic,
  url: string,
  currentText: string,
  products: string[],
  oldProducts: string[],
  discontinued: string | null,
  archiveYear: string | null,
  opts: {
    mode?: "hinted" | "cold";
    companyNameHint?: string | null;
    onLog?: (message: string) => void;
    /** Epoch ms after which optional extra rounds are skipped. */
    deadlineAt?: number;
  } = {}
): Promise<{
  companyName: string;
  anchors: CompanyAnchor[];
  searchCount: number;
}> {
  const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
  const domain = parsed.hostname.replace(/^www\./i, "");
  const stem = domain.split(".")[0];
  const fallbackName =
    opts.companyNameHint?.trim() ||
    stem.charAt(0).toUpperCase() + stem.slice(1);
  const mode = opts.mode ?? "hinted";
  const log = opts.onLog ?? (() => {});

  if (mode === "cold") {
    return researchAnchorsCold({
      client,
      url,
      domain,
      companyName: fallbackName,
      currentText,
      products,
      log,
      deadlineAt: opts.deadlineAt,
    });
  }

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

    const resp = await callClaudeWithWebSearch(client, 4, {
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: `You are helping write a personal cold-outreach hook. The hook will start "I have studied {Company} going back to {ANCHOR}." where ANCHOR is a SPECIFIC, VERIFIABLE artifact from the company's history. Generic descriptions of current products are unusable.

Examples of great anchors (these came from real research, not the homepage):
- "the days operating as Resolution Systems" (a former company name)
- "the release of Herbst Attendance" (a specific named product launch)
- "the release of ArcMiner" (a specific named product launch)
- "the days when the Okappy mascot would appear on the Team page of the website" (obscure trivia from old snapshots)

TARGET COMPANY: ${url}
Company name: ${fallbackName}${productsHint}${oldProductsHint}${discontinuedHint}

Excerpt from the company's current website:
${currentText.slice(0, 1200)}

YOUR TASK:
1. Confirm the company's canonical brand name (e.g. "MaxMine", not "maxmine.com").
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
- "factConfidence" is how sure you are the fact is true; "dateConfidence" is how sure you are of the year. They are often different — say so honestly, and use "low" when inferring.
- Include "sourceUrl" whenever the claim came from a page you searched.

Return STRICT JSON only, no markdown fences, no commentary:
{
  "companyName": "MaxMine",
  "anchors": [
    {"type": "former_name", "anchor": "the days operating as Resolution Systems", "sourceUrl": "https://...", "sourceLabel": "where this came from", "year": null, "factConfidence": "high", "dateConfidence": "low", "evidence": "one sentence: where you found this"}
  ]
}

If you genuinely cannot find anything specific via web search, still return the companyName and an empty anchors array. Do not invent.`,
        },
      ],
    });

    const searchCount = webSearchCount(resp);
    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length === 0) {
      return { companyName: fallbackName, anchors: [], searchCount };
    }
    const parsedJson = parseJsonObject(
      textBlocks[textBlocks.length - 1].text.trim()
    );
    if (!parsedJson) {
      log("Anchor research returned an unreadable answer — no anchors used.");
      return { companyName: fallbackName, anchors: [], searchCount };
    }

    const companyName =
      typeof parsedJson.companyName === "string" && parsedJson.companyName.trim()
        ? parsedJson.companyName.trim()
        : fallbackName;

    // The hinted path keeps its historical tolerance: the Wayback signals are
    // the primary evidence here, so an anchor without a URL is still usable.
    const rawAnchors = Array.isArray(parsedJson.anchors)
      ? parsedJson.anchors
      : [];
    const anchors: CompanyAnchor[] = rawAnchors
      .slice(0, 5)
      .filter(
        (a: unknown) =>
          !!a &&
          typeof a === "object" &&
          typeof (a as Record<string, unknown>).anchor === "string" &&
          ((a as Record<string, unknown>).anchor as string).trim().length > 0 &&
          ANCHOR_TYPES.has((a as Record<string, unknown>).type as CompanyAnchor["type"])
      )
      .map((item: unknown) => {
        const a = item as Record<string, unknown>;
        const sourceUrl =
          typeof a.sourceUrl === "string" && /^https?:\/\//i.test(a.sourceUrl)
            ? a.sourceUrl
            : null;
        return {
          type: a.type as CompanyAnchor["type"],
          anchor: (a.anchor as string).trim(),
          evidence: typeof a.evidence === "string" ? a.evidence : "",
          sourceUrl,
          sourceLabel:
            typeof a.sourceLabel === "string" && a.sourceLabel.trim()
              ? a.sourceLabel.trim()
              : sourceUrl
                ? urlHost(sourceUrl)
                : "Wayback Machine history",
          year: normalizeYear(a.year),
          factConfidence: normalizeConfidence(a.factConfidence),
          dateConfidence: normalizeConfidence(a.dateConfidence),
        };
      });

    return { companyName, anchors, searchCount };
  } catch {
    return { companyName: fallbackName, anchors: [], searchCount: 0 };
  }
}

/**
 * The "cold" ladder: two rounds of targeted provenance searches, the second
 * only running if the first found nothing solid.
 */
async function researchAnchorsCold(args: {
  client: Anthropic;
  url: string;
  domain: string;
  companyName: string;
  currentText: string;
  products: string[];
  log: (message: string) => void;
  deadlineAt?: number;
}): Promise<{
  companyName: string;
  anchors: CompanyAnchor[];
  searchCount: number;
}> {
  const { client, url, domain, companyName, currentText, products, log } = args;

  /** Is there room for a step that typically takes this long? */
  const roomFor = (ms: number) =>
    args.deadlineAt === undefined || Date.now() + ms <= args.deadlineAt;

  // A compact identity block replaces the old 1,500-char website excerpt. These
  // are searches for historical records; homepage copy does not help them.
  const identity = [
    `COMPANY: ${companyName}`,
    `WEBSITE: ${url}`,
    products.length > 0
      ? `SELLS TODAY: ${products.slice(0, 6).join(", ")}`
      : null,
    currentText.trim()
      ? `IN THEIR OWN WORDS: ${currentText.trim().slice(0, 300)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const companyHost = domain.toLowerCase();
  let searchCount = 0;
  let anchors: CompanyAnchor[] = [];

  const runRound = async (
    classes: ProvenanceClass[],
    alreadyTried: string[]
  ): Promise<CompanyAnchor[]> => {
    const resp = await callClaudeWithWebSearch(client, 3, {
      model: "claude-sonnet-4-6",
      // Five anchors with URLs and evidence overflow 1200 tokens, and a cut-off
      // object is unparseable -- the round's whole result was being discarded
      // as "unreadable" when the research had actually succeeded.
      max_tokens: 2400,
      messages: [
        {
          role: "user",
          content: buildColdRoundPrompt(
            identity,
            companyName,
            domain,
            classes,
            alreadyTried,
            products
          ),
        },
      ],
    });
    searchCount += webSearchCount(resp);

    const textBlocks = resp.content.filter(
      (b: { type: string }) => b.type === "text"
    );
    if (textBlocks.length === 0) return [];
    const parsedJson = parseJsonObject(
      textBlocks[textBlocks.length - 1].text.trim()
    );
    if (!parsedJson) {
      log("A research round returned an unreadable answer — skipping it.");
      return [];
    }
    return validateColdAnchors(
      parsedJson.anchors,
      collectCitationUrls(resp),
      companyHost
    );
  };

  try {
    anchors = await runRound(PROVENANCE_ROUND_1, []);
    log(
      `Round 1 (former name, own history page, press releases): ${anchors.length} verified anchor(s) from ${searchCount} search(es).`
    );

    if (!hasStrongAnchor(anchors)) {
      // A round takes roughly a minute. Skipping it beats being killed by the
      // platform with the whole run's research lost.
      if (!roomFor(75_000)) {
        log(
          "Not enough time left in this run for a second research round — using what round 1 found.",
        );
      } else {
        const round2 = await runRound(
          PROVENANCE_ROUND_2,
          PROVENANCE_ROUND_1.map((c) => c.label)
        );
        log(
          `Round 2 (formation events, release notes, registries): ${round2.length} verified anchor(s).`
        );
        // Both rounds are already validated, so only re-ranking is left.
        anchors = rankAnchors([...anchors, ...round2]);
      }
    }

    // Only chase a date when we believe the fact but not the year. Costs one
    // free Jina fetch plus a 60-token model call.
    const best = anchors[0];
    if (
      best &&
      best.factConfidence === "high" &&
      best.dateConfidence !== "high" &&
      best.sourceUrl &&
      roomFor(30_000)
    ) {
      const confirmed = await confirmAnchorYear(client, best);
      if (confirmed.year && confirmed.dateConfidence === "high") {
        log(`Confirmed ${confirmed.year} from the source page.`);
        anchors = [confirmed, ...anchors.slice(1)];
      }
    }
  } catch (err) {
    log(
      `Public-source research failed: ${err instanceof Error ? err.message : "unknown error"}.`
    );
  }

  return { companyName, anchors, searchCount };
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
  anchors: CompanyAnchor[]
): Promise<{ hook: string; anchor: CompanyAnchor | null }> {
  const anchorsBlock =
    anchors.length > 0
      ? `\nRESEARCHED ANCHORS (highest-signal — prefer these):\n${anchors
          .map((a, i) => {
            const facts = [
              `fact confidence: ${a.factConfidence ?? "low"}`,
              `date confidence: ${a.dateConfidence ?? "low"}`,
              a.year ? `year: ${a.year}` : null,
              a.sourceLabel ? `source: ${a.sourceLabel}` : null,
            ]
              .filter(Boolean)
              .join(", ");
            return `${i + 1}. [${a.type}] "${a.anchor}"\n   ${facts}\n   ${a.evidence || "no further detail"}`;
          })
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

THE FOUNDING IS NOT A HOOK. "the founding in Ontario, Canada in 1983 under Les M. Bildy" is a real example of a bad opener: true, verifiable, and completely worthless, because it is the first line of their About page and of every directory entry about them. It tells the reader we looked for five seconds. Tier 6 means a specific thing they were DOING in their early years, not the founding event itself, and it is reachable only when tiers 1-5 are genuinely empty. Do not name the founder. Do not name the founding city. Do not say "the founding".

CONFIDENCE RULES (these override the hierarchy — a defensible weaker anchor beats a shaky stronger one):
- Prefer an anchor with "fact confidence: high" over a more specific one with lower fact confidence. The recipient is the one person alive who can tell we got it wrong.
- If the anchor you use has "date confidence" of anything other than high, write it WITHOUT the year. "the release of CSiPlant" — never "the release of CSiPlant in 2019". Omitting an uncertain date costs nothing; asserting a wrong one costs the reply.
- Only include a year when that anchor's date confidence is high.

HARD BANS:
- The founding year, founding city, or founder's name as the anchor. See above.
- Generic descriptions of current products/positioning ("their focus on real-time worksite intelligence", "Smart Maintenance Management CMMS built for industrial asset-heavy environments"). If a reader could have written it after a 5-second glance at the homepage, it is banned.
- Bare-year openers like "I've studied your business going back to 2002." with no specific clause after.
- Hype words: "leading", "innovative", "cutting-edge", "world-class", flattery of any kind.
- Em dashes anywhere in the output.
- A greeting ("Hi", "Hello", or a name).
- Wrapping quotes around the hook.

LENGTH & SHAPE:
- Write EXACTLY ONE sentence, under 25 words. Every golden example above is 12-16 words. Shorter lands harder.
- The anchor STANDS ALONE. Do not append a clause explaining what it was, what it covered, or why it mattered. "going back to the \"What's New in COMPRESS 2016\" webinar" is finished; adding ", where they walked through the build numbering system and fielded questions on licensing" makes it worse. Name the thing and stop.
- READ IT ALOUD. The anchor slots straight after "going back to", so it must sound like a person talking. Natural anchors nearly always start "the days...", "the release of...", "the launch of...", or "back when...". If it reads like a database record ("the founding in Ontario, Canada in 1983 under Les M. Bildy"), rewrite it.
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
  return { hook: result, anchor: matchAnchorToHook(result, anchors) };
}

/**
 * Work out which researched anchor the hook actually used, so the UI can show
 * its source and confidence next to it.
 *
 * The hook prompt returns prose, not a structured choice, so match on the
 * distinctive words of each anchor. Falls back to the top-ranked anchor, which
 * is the one the prompt is told to prefer.
 */
function matchAnchorToHook(
  hook: string,
  anchors: CompanyAnchor[]
): CompanyAnchor | null {
  if (anchors.length === 0) return null;
  const haystack = hook.toLowerCase();

  // Ignore the connective words every anchor shares ("the days operating as")
  // and match on the parts that actually identify one — names, products.
  const STOPWORDS = new Set([
    "the", "days", "release", "launch", "of", "as", "operating", "a", "an",
    "and", "in", "on", "to", "for", "when", "their", "its", "was", "were",
    "with", "from", "your", "you", "company", "product", "early", "first",
  ]);

  let best: { anchor: CompanyAnchor; score: number } | null = null;
  for (const anchor of anchors) {
    const terms = anchor.anchor
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    if (terms.length === 0) continue;
    const hits = terms.filter((w) => haystack.includes(w)).length;
    const score = hits / terms.length;
    if (score >= 0.5 && (!best || score > best.score)) {
      best = { anchor, score };
    }
  }
  return best?.anchor ?? anchors[0];
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
