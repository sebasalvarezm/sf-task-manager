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
  extractCompanyNameFromText,
  extractOutreachParagraph,
  personalizeOutreach,
  generateEmailHook,
  researchCompanyAnchors,
  findGroupFileName,
  waybackPlaybackCooldownRemainingMs,
  type WaybackStatus,
  type WaybackLookupResult,
  type WaybackSnapshotFailure,
  type CompanyAnchor,
  type GroupMatch,
} from "@/lib/scout";
import {
  buildPrepackagedEmail,
  type PrepackagedEmail,
} from "@/lib/email-prepackage";
import {
  findBusinessLocation,
  findBusinessDinnerRestaurants,
  locationMatchesWebsiteCountry,
} from "@/lib/geocoding";

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
    warning?: string | null;
  };
  archiveUrl: string | null;
  archiveYear: string | null;
  wbLabel: string;
  waybackStatus: WaybackStatus | null;
  /** HTTP status behind a snapshot transport failure, so the UI can name it. */
  waybackHttpStatus?: number | null;
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
  /**
   * Where the hook's evidence came from. "wayback" means the archive supplied
   * the product history; "web_research" means the archive gave us nothing and
   * the hook was built from public sources instead.
   */
  hookSource?: "wayback" | "web_research" | null;
  /** The researched anchor the hook actually used, with its source URL. */
  hookAnchor?: CompanyAnchor | null;
  /** Web searches spent on hook research, for cost tracking. */
  hookSearchCount?: number;
  competitors: { name: string; differentiator: string }[];
  prepackagedEmail?: PrepackagedEmail | null;
  logs: string[];
};

/**
 * Fast first pass for bulk sourcing. It uses the exact same website evidence,
 * group definitions, and Sonnet classifier as the full run, but stops before
 * Wayback, address, hook, and email research. The full run can then reuse this
 * result so quality stays identical and the group-classification AI call is
 * not repeated.
 */
export async function runFastSourcingClassification(
  url: string,
): Promise<GroupMatch> {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    throw new Error("AI service not configured (missing ANTHROPIC_API_KEY)");
  }
  const normalized = url.startsWith("http") ? url : `https://${url}`;
  const currentText = await scrapeWithJina(normalized);
  if (!currentText || currentText.length < 100) {
    throw new Error("Could not extract enough website text for classification");
  }
  if (isParkedPage(currentText)) {
    throw new Error("This domain appears to be parked or a placeholder page");
  }
  return matchGroup(anthropic, currentText, loadGroupFiles());
}

/**
 * Re-research just the email hook for a company that has already been sourced,
 * forcing the public-source ("cold") path.
 *
 * This exists so a weak hook can be improved without re-running the whole
 * pipeline. It reuses the products, founding year, and location already stored
 * on the previous result, so the only fresh work is one website scrape, the
 * research ladder, and the hook itself — a few seconds and a few cents rather
 * than a full ~15-call research pass.
 *
 * The prepackaged email is rebuilt too, otherwise the draft would keep quoting
 * the old hook.
 */
export async function rerunHookResearch(
  stored: SourcingResult,
): Promise<Partial<SourcingResult> & { logs: string[] }> {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    throw new Error("AI service not configured (missing ANTHROPIC_API_KEY)");
  }

  const logs: string[] = [];
  const deadlineAt = Date.now() + RUN_BUDGET_MS;
  const normalized = stored.url.startsWith("http")
    ? stored.url
    : `https://${stored.url}`;

  // The stored currentText is truncated to 500 chars before it is written to
  // the database, so re-scrape rather than research against a fragment.
  const currentText = (await scrapeWithJina(normalized)) ?? "";
  if (currentText) {
    logs.push("Re-read the company website.");
  } else {
    logs.push("Could not re-read the website — researching from public sources only.");
  }

  const companyNameHint =
    extractCompanyNameFromText(currentText) || quickCompanyName(normalized);

  logs.push("Researching rebrand and product history from public sources...");
  const research = await researchCompanyAnchors(
    anthropic,
    normalized,
    currentText,
    stored.products ?? [],
    [], // force the cold ladder: ignore any archive hints
    null,
    null,
    {
      mode: "cold",
      companyNameHint,
      onLog: (message) => logs.push(message),
      deadlineAt,
    },
  );
  logs.push(
    `Found ${research.anchors.length} verified anchor(s) using ${research.searchCount} web search(es).`,
  );

  // Same rule as the full run: with nothing verified to point at, the model
  // paraphrases the homepage and the result reads researched without being so.
  // Report the miss instead of dressing it up.
  if (research.anchors.length === 0) {
    logs.push(
      "No verifiable historical detail was found in public sources, so the hook was left alone rather than replaced with a homepage paraphrase.",
    );
    return {
      hookSearchCount: research.searchCount,
      logs,
    };
  }

  const generated = await generateEmailHook(
    anthropic,
    research.companyName,
    normalized,
    currentText,
    stored.products ?? [],
    stored.foundingYear ?? null,
    [],
    null,
    null,
    research.anchors,
  );

  const hookAnchor = generated.anchor;
  if (hookAnchor) {
    logs.push(
      `Hook anchor: ${hookAnchor.anchor} (source: ${hookAnchor.sourceLabel ?? "unnamed source"}, confidence: ${hookAnchor.factConfidence ?? "low"}).`,
    );
  }

  // Rebuild the draft so it quotes the new hook rather than the old one.
  const prepackagedEmail = buildPrepackagedEmail({
    mainGroup: stored.portfolioMatch?.mainGroup ?? null,
    subgroup: stored.portfolioMatch?.group ?? null,
    emailHook: generated.hook,
    outreachParagraph: stored.outreachParagraph ?? null,
    address: stored.address ?? null,
    locationConfidence: stored.locationConfidence ?? "none",
    restaurants: stored.restaurants ?? [],
    now: new Date(),
  });

  return {
    emailHook: generated.hook,
    hookAnchor,
    hookSource: "web_research",
    hookSearchCount: research.searchCount,
    prepackagedEmail,
    logs,
  };
}

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

/**
 * Wall-clock ceiling for the whole archive phase — the CDX snapshot list plus
 * every archived-page download. Archive.org cooldowns run 30-60s each and the
 * platform kills the whole run at 300s, so the phase gives up on its own rather
 * than starving the rest of the research.
 */
const WAYBACK_PHASE_BUDGET_MS = 120_000;

/**
 * Wall-clock budget for one company's whole run, held 30s under the platform's
 * 300s kill so the run can finish tidily and return its result instead of being
 * cut off mid-research.
 */
const RUN_BUDGET_MS = 270_000;

/**
 * CDX answers in 5-27s when Archive.org is busy, so this sits above the slowest
 * healthy response measured rather than cutting one off as "no snapshots".
 */
const WAYBACK_CDX_TIMEOUT_MS = 45_000;

/**
 * Archive.org outages last hours or days, not seconds. Once the index has
 * refused this process three times in a row, every later company in the same
 * run is going to fail too — so stop paying the 120s phase budget per company
 * and go straight to public-source research instead.
 *
 * Module-level on purpose: a bulk run of 50 companies shares one process, so
 * the first three failures spare the other 47 companies the wait. Any success
 * resets it, so a brief hiccup does not disable the archive for the whole run.
 */
const WAYBACK_OUTAGE_STRIKES = 3;
let waybackIndexFailureStreak = 0;

function noteWaybackIndexOutcome(status: WaybackStatus | null): void {
  const transportFailure =
    status === "timeout" || status === "http_error" || status === "network_error";
  waybackIndexFailureStreak = transportFailure
    ? waybackIndexFailureStreak + 1
    : 0;
}

function waybackLooksDown(): boolean {
  return waybackIndexFailureStreak >= WAYBACK_OUTAGE_STRIKES;
}

/** Exported for tests and for the "run fresh" path to clear a stale verdict. */
export function resetWaybackOutageState(): void {
  waybackIndexFailureStreak = 0;
}

function snapshotFailureStatus(
  failure: WaybackSnapshotFailure | null,
): WaybackStatus | null {
  if (failure === "timeout") return "snapshot_timeout";
  if (failure === "http_error") return "snapshot_http_error";
  if (failure === "network_error") return "snapshot_network_error";
  return null;
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
  portfolioMatchOverride?: SourcingResult["portfolioMatch"];
}): Promise<SourcingResult> {
  const { url, onProgress, portfolioMatchOverride } = input;
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    throw new Error("AI service not configured (missing ANTHROPIC_API_KEY)");
  }

  const normalized = url.startsWith("http") ? url : `https://${url}`;
  const logs: string[] = [];

  // The platform kills the whole run at 300s. Every optional late-stage step
  // checks against this so the run finishes and returns what it has, rather
  // than being killed and losing everything it already researched.
  const runDeadlineAt = Date.now() + RUN_BUDGET_MS;

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
  const portfolioMatch: GroupMatch = portfolioMatchOverride
    ? {
        ...portfolioMatchOverride,
        mainGroup: portfolioMatchOverride.mainGroup ?? null,
        confidence: portfolioMatchOverride.confidence ?? null,
      }
    : await matchGroup(anthropic, currentText, groups);
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
    if (portfolioMatch.warning) logs.push(`WARNING: ${portfolioMatch.warning}. No email template was assigned.`);
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

  // One budget covers the snapshot list AND the page downloads, so a slow CDX
  // response cannot push the whole run toward the platform's 300s kill.
  const waybackDeadlineAt = Date.now() + WAYBACK_PHASE_BUDGET_MS;

  // Skip the archive entirely once it has proven to be down in this process.
  // Waiting out the phase budget again would only delay the research that is
  // going to produce the hook anyway.
  const skipWaybackForOutage = waybackLooksDown();
  if (skipWaybackForOutage) {
    logs.push(
      "Skipping the Wayback Machine — it has failed repeatedly in this run, so it is an Archive.org outage rather than a fact about this company. Going straight to public-source research.",
    );
  } else {
    logs.push(`Fetching Wayback Machine snapshots from ${wbLabel}...`);
  }

  const waybackLookup: WaybackLookupResult = skipWaybackForOutage
    ? { candidates: [], status: "network_error", primaryFailure: null }
    : await getWaybackCandidates(
        normalized,
        wbFrom,
        wbTo,
        Math.min(WAYBACK_CDX_TIMEOUT_MS, Math.max(5_000, waybackDeadlineAt - Date.now())),
      );
  const { candidates } = waybackLookup;
  let waybackStatus = waybackLookup.status;
  let waybackHttpStatus: number | null = null;

  if (!skipWaybackForOutage) noteWaybackIndexOutcome(waybackStatus);

  if (skipWaybackForOutage) {
    // Message already logged above; skip the per-status explanations.
  } else if (waybackStatus === "fallback_used") {
    // Saying "returned nothing" for a CDX timeout reads as a fact about the
    // company. It is not — the snapshot list simply could not be read.
    logs.push(
      waybackLookup.primaryFailure && waybackLookup.primaryFailure !== "empty"
        ? `Wayback CDX could not be read (${waybackLookup.primaryFailure}) — using the Availability API fallback. The snapshot list may be incomplete.`
        : "Wayback CDX has no snapshots in this window — using Availability API fallback snapshot.",
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

    const validSnapshots: Array<{
      candidate: (typeof candidates)[number];
      result: Awaited<ReturnType<typeof fetchWaybackSnapshot>>;
    }> = [];
    let consecutiveTransportFailures = 0;
    let snapshotPlaybackAvailable = true;

    // Archive.org rejects request bursts. Fetch one snapshot at a time and
    // stop as soon as the three pages used by the analysis are available.
    for (const candidate of candidates) {
      if (validSnapshots.length >= 3) break;
      if (Date.now() > waybackDeadlineAt) {
        logs.push(
          `Stopped archived-page downloads after ${Math.round(WAYBACK_PHASE_BUDGET_MS / 1000)}s waiting on Archive.org; the rest of the research continued.`,
        );
        break;
      }
      const cooldownMs = waybackPlaybackCooldownRemainingMs();
      if (cooldownMs > 0) {
        logs.push(
          `Archive.org asked us to slow down — waiting ${Math.ceil(cooldownMs / 1000)}s before the next archived page.`,
        );
      }
      const result = await fetchWaybackSnapshot(candidate.url, domainStem, waybackDeadlineAt);
      if (result.skipReason) {
        logs.push(`Skipping ${candidate.timestamp.slice(0, 4)} snapshot — ${result.skipReason}.`);
      } else if (result.cached) {
        logs.push(`Reused stored ${candidate.timestamp.slice(0, 4)} snapshot (no download needed).`);
      }

      const transportStatus = snapshotFailureStatus(result.failureType);
      if (transportStatus) {
        consecutiveTransportFailures++;
        waybackStatus = transportStatus;
        waybackHttpStatus = result.httpStatus;
        // Each snapshot has already been retried three times. Allow a few bad
        // years because Wayback commonly serves an isolated 503 and then
        // recovers, but stop after a sustained block rather than hammering it.
        if (consecutiveTransportFailures >= 4) {
          snapshotPlaybackAvailable = false;
          logs.push(
            "Stopped archived-page downloads after repeated Wayback transport failures; snapshot records exist, but their pages could not be retrieved.",
          );
          break;
        }
        continue;
      }

      consecutiveTransportFailures = 0;
      if (result.text && !result.skipReason) {
        validSnapshots.push({ candidate, result });
      }
    }

    if (validSnapshots.length > 0) {
      // Intermittent playback failures were recovered; retain the successful
      // lookup status instead of presenting the run as a Wayback outage.
      waybackStatus = waybackLookup.status;
      waybackHttpStatus = null;
      archiveUrl = validSnapshots[0].candidate.url;
      archiveTimestamp = validSnapshots[0].candidate.timestamp;
    }
    const snapshotProducts = await Promise.all(
      validSnapshots.map(({ candidate, result }) => {
        const year = candidate.timestamp.slice(0, 4);
        logs.push(`Valid snapshot found from ${year}.`);
        return extractProducts(anthropic, result.text!, `archived (${year})`);
      }),
    );
    snapshotProducts.forEach((ps) => allOldProducts.push(...ps));

    // Probe interior product/solution/services pages only when snapshot
    // playback is healthy. If it is blocked, extra CDX/playback calls make the
    // throttling worse and cannot improve the result.
    const interiorKeywords = [
      "product",
      "solution",
      "service",
      "platform",
      "software",
    ];
    let interiorChecked = 0;
    for (const keyword of snapshotPlaybackAvailable ? interiorKeywords : []) {
      if (interiorChecked >= 3 || Date.now() > waybackDeadlineAt) break;
      const ics = await getInteriorCandidates(
        domainOnly,
        keyword,
        wbFrom,
        wbTo,
        1,
      );
      for (const ic of ics) {
        if (interiorChecked >= 3 || Date.now() > waybackDeadlineAt) break;
        const r = await fetchWaybackSnapshot(ic.url, domainStem, waybackDeadlineAt);
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
    if (snapshotPlaybackAvailable && allOldProducts.length < 3 && archiveUrl) {
      const newsKeywords = [
        "news",
        "press",
        "blog",
        "media",
        "announcements",
      ];
      let newsChecked = 0;
      for (const keyword of newsKeywords) {
        if (newsChecked >= 2 || Date.now() > waybackDeadlineAt) break;
        const ncs = await getInteriorCandidates(
          domainOnly,
          keyword,
          wbFrom,
          wbTo,
          1,
        );
        for (const nc of ncs) {
          if (newsChecked >= 2 || Date.now() > waybackDeadlineAt) break;
          const r = await fetchWaybackSnapshot(nc.url, domainStem, waybackDeadlineAt);
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
  // Prefer the registered name printed on the site over the domain stem. The
  // stem is often not the company ("fast-soft.com" is FasTrak SoftWorks), and
  // every lookup below searches by this name.
  const extractedCompanyName = extractCompanyNameFromText(currentText);
  const sourceCompanyName = extractedCompanyName || quickCompanyName(normalized);
  logs.push(
    extractedCompanyName
      ? `Company name from the website: ${sourceCompanyName}.`
      : `No registered name found on the website — searching as "${sourceCompanyName}" from the domain.`,
  );
  const [websiteAddressInfo, mapsLocation, outreachParagraph] = await Promise.all([
    extractAddress(anthropic, currentText, normalized, sourceCompanyName, { allowWebSearch: false }),
    findBusinessLocation(sourceCompanyName, normalized).catch(() => null),
    generateOutreach(
      anthropic,
      normalized,
      currentText,
      products,
      portfolioMatch.group,
      outreachLogs,
    ),
  ]);
  let addressInfo = websiteAddressInfo;
  if (
    addressInfo.address &&
    !locationMatchesWebsiteCountry(addressInfo.address, normalized)
  ) {
    logs.push(`Rejected location that conflicts with the website's country: ${addressInfo.address}`);
    addressInfo = { address: null, source: null, sourceUrl: null, confidence: "none" };
  }
  if (!addressInfo.address && mapsLocation) {
    addressInfo = {
      address: mapsLocation.formattedAddress,
      source: "Google Maps",
      sourceUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsLocation.formattedAddress)}`,
      confidence: /\d/.test(mapsLocation.formattedAddress) ? "exact" : "city",
    };
  }
  // Preserve the old full web-search behavior as a fallback so the efficiency
  // change can never turn a formerly-resolvable company into a blank location.
  if (!addressInfo.address) {
    addressInfo = await extractAddress(anthropic, currentText, normalized, sourceCompanyName);
    if (
      addressInfo.address &&
      !locationMatchesWebsiteCountry(addressInfo.address, normalized)
    ) {
      logs.push(`Rejected web-search location that conflicts with the website's country: ${addressInfo.address}`);
      addressInfo = { address: null, source: null, sourceUrl: null, confidence: "none" };
    }
  }
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
  const mapsRestaurants = address
    ? await findBusinessDinnerRestaurants(address).catch(() => [])
    : [];
  const restaurantResult = mapsRestaurants.length > 0
    ? { restaurants: mapsRestaurants, city: address }
    : await findRestaurants(anthropic, address, sourceCompanyName);
  const restaurants = restaurantResult.restaurants;
  if (restaurants.length > 0) {
    logs.push(`Found ${restaurants.length} restaurant recommendation(s).`);
  } else {
    logs.push("Could not retrieve restaurant recommendations.");
  }

  // Address rescue: if address extraction failed but the restaurant search
  // located the company's city, keep that city as the location so the result
  // always shows at least "City, ST".
  if (
    !address &&
    restaurantResult.city &&
    locationMatchesWebsiteCountry(restaurantResult.city, normalized)
  ) {
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
  // Gate on whether we actually got HISTORY, not on the Wayback status code. A
  // domain with a genuinely empty archive is in the same position as one hit by
  // an outage: there is no archived product history to build a hook from, and
  // public-source research is the better option in both cases.
  const waybackGaveHistory = oldProducts.length > 0 || !!discontinued;
  const anchorMode = waybackGaveHistory ? "hinted" : "cold";

  logs.push(
    waybackGaveHistory
      ? "Researching company anchors for hook..."
      : "No archived product history to work from — researching the company's rebrand and product history from public sources instead.",
  );

  let companyName = sourceCompanyName;
  let anchors: CompanyAnchor[] = [];
  let hookSearchCount = 0;
  try {
    const r = await researchCompanyAnchors(
      anthropic,
      normalized,
      currentText,
      products,
      oldProducts,
      discontinued,
      archiveYear,
      {
        mode: anchorMode,
        // The registered name from the website beats anything a search would
        // derive, and it is already computed above — so the search budget goes
        // entirely on history rather than on re-deriving the name.
        companyNameHint: sourceCompanyName,
        onLog: (message) => logs.push(message),
        deadlineAt: runDeadlineAt,
      },
    );
    companyName = r.companyName;
    anchors = r.anchors;
    hookSearchCount = r.searchCount;
    logs.push(
      `Found ${anchors.length} candidate anchor(s) using ${hookSearchCount} web search(es).`,
    );
  } catch (err) {
    logs.push(
      `Anchor research failed: ${err instanceof Error ? err.message : "unknown error"}.`,
    );
  }

  // With no verified anchor and no archive history there is nothing specific
  // left to build a hook from, and the model will paraphrase the homepage —
  // producing exactly the unfalsifiable opener its own prompt bans. A missing
  // hook leaves the template placeholder and a warning, which is honest; a
  // homepage paraphrase looks finished and is not. Skipping also saves a call.
  const hasHookEvidence =
    anchors.length > 0 || oldProducts.length > 0 || !!discontinued;

  let emailHook: string | null = null;
  let hookAnchor: CompanyAnchor | null = null;

  if (!hasHookEvidence) {
    logs.push(
      "No verifiable historical detail was found for this company, so no hook was written. The draft keeps its placeholder sentence — this one needs a human to find the angle.",
    );
  } else {
    logs.push("Generating email opening hook...");
    try {
      const generated = await generateEmailHook(
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
      );
      emailHook = generated.hook;
      hookAnchor = generated.anchor;
      if (hookAnchor) {
        const source = hookAnchor.sourceLabel ?? "unnamed source";
        logs.push(
          `Hook anchor: ${hookAnchor.anchor} (source: ${source}, confidence: ${hookAnchor.factConfidence ?? "low"}).`,
        );
      }
      logs.push("Email hook complete.");
    } catch (err) {
      logs.push(
        `Hook generation failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  // "wayback" only when the archive genuinely supplied the evidence. Anything
  // else that produced a hook did so from public sources.
  const hookSource: SourcingResult["hookSource"] = emailHook
    ? waybackGaveHistory
      ? "wayback"
      : "web_research"
    : null;

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
    waybackHttpStatus,
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
    hookSource,
    hookAnchor,
    hookSearchCount,
    competitors,
    prepackagedEmail,
    logs,
  };
}
