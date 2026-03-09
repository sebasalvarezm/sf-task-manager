"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PortfolioMatch = { matched: boolean; group: string | null };

type ScrapeResult = {
  currentText: string;
  products: string[];
  foundingYear: number | null;
  portfolioMatch: PortfolioMatch;
};

type HistoryResult = {
  archiveUrl: string | null;
  archiveYear: string | null;
  wbLabel: string;
  discontinued: string | null;
  discontinuedNote: string | null;
  oldProducts: string[];
};

type DetailsResult = {
  address: string | null;
  restaurants: { name: string; description: string }[];
  outreachParagraph: string | null;
};

type CompanyResult = {
  url: string;
  domain: string;
  status: "idle" | "scraping" | "history" | "details" | "done" | "error";
  error: string | null;
  scrape: ScrapeResult | null;
  history: HistoryResult | null;
  details: DetailsResult | null;
};

// ---------------------------------------------------------------------------
// localStorage cache
// ---------------------------------------------------------------------------

const CACHE_KEY = "sourcing_results_cache";

type CachedResult = {
  scrape: ScrapeResult;
  history: HistoryResult | null;
  details: DetailsResult | null;
  cachedAt: number;
};

function getCache(): Record<string, CachedResult> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveToCache(domain: string, result: CompanyResult) {
  if (!result.scrape) return;
  try {
    const cache = getCache();
    cache[domain] = {
      scrape: {
        ...result.scrape,
        currentText: result.scrape.currentText.slice(0, 500), // don't store full text in cache
      },
      history: result.history,
      details: result.details,
      cachedAt: Date.now(),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable
  }
}

function getCachedResult(domain: string): CachedResult | null {
  const cache = getCache();
  return cache[domain] || null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SourcingPage() {
  const router = useRouter();
  const [urlCount, setUrlCount] = useState(1);
  const [urls, setUrls] = useState<string[]>([""]);
  const [results, setResults] = useState<CompanyResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Restore cached results on mount
  useEffect(() => {
    // nothing to restore on mount — results load when user runs analysis
  }, []);

  function handleUrlChange(index: number, value: string) {
    const updated = [...urls];
    updated[index] = value;
    setUrls(updated);
  }

  function addUrlField() {
    if (urlCount >= 5) return;
    setUrlCount((c) => c + 1);
    setUrls((prev) => [...prev, ""]);
  }

  function getDomain(url: string): string {
    try {
      const parsed = new URL(
        url.startsWith("http") ? url : `https://${url}`
      );
      return parsed.hostname.replace("www.", "");
    } catch {
      return url;
    }
  }

  const updateResult = useCallback(
    (index: number, updates: Partial<CompanyResult>) => {
      setResults((prev) => {
        const copy = [...prev];
        copy[index] = { ...copy[index], ...updates };
        return copy;
      });
    },
    []
  );

  async function runPipeline(entry: CompanyResult, index: number) {
    const normalized = entry.url.startsWith("http")
      ? entry.url
      : `https://${entry.url}`;

    // --- Step 1: Scrape ---
    updateResult(index, { status: "scraping" });
    try {
      const res = await fetch("/api/sourcing/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      const data = await res.json();
      if (!res.ok) {
        updateResult(index, {
          status: "error",
          error: data.error || "Scraping failed",
        });
        return;
      }
      updateResult(index, { scrape: data });
    } catch (err) {
      updateResult(index, {
        status: "error",
        error: err instanceof Error ? err.message : "Network error",
      });
      return;
    }

    // Get the latest scrape data
    let latestScrape: ScrapeResult | null = null;
    setResults((prev) => {
      latestScrape = prev[index].scrape;
      return prev;
    });
    // Small delay to ensure state is updated
    await new Promise((r) => setTimeout(r, 50));
    setResults((prev) => {
      latestScrape = prev[index].scrape;
      return prev;
    });

    if (!latestScrape) {
      updateResult(index, { status: "error", error: "Scrape returned no data" });
      return;
    }

    // --- Step 2: History ---
    updateResult(index, { status: "history" });
    try {
      const res = await fetch("/api/sourcing/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: normalized,
          foundingYear: (latestScrape as ScrapeResult).foundingYear,
          currentProducts: (latestScrape as ScrapeResult).products,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        updateResult(index, { history: data });
      }
    } catch {
      // Non-critical — continue without history
    }

    // --- Step 3: Details ---
    updateResult(index, { status: "details" });
    try {
      const res = await fetch("/api/sourcing/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: normalized,
          currentText: (latestScrape as ScrapeResult).currentText,
          products: (latestScrape as ScrapeResult).products,
          portfolioGroup: (latestScrape as ScrapeResult).portfolioMatch.group,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        updateResult(index, { details: data });
      }
    } catch {
      // Non-critical — continue without details
    }

    // Mark as done and cache
    updateResult(index, { status: "done" });
    setResults((prev) => {
      saveToCache(prev[index].domain, prev[index]);
      return prev;
    });
  }

  async function handleRun() {
    // Collect non-empty unique URLs
    const validUrls = urls
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((u) => (u.startsWith("http") ? u : `https://${u}`));

    const unique = [...new Set(validUrls)];
    if (unique.length === 0) return;

    setIsRunning(true);
    setActiveTab(0);

    // Initialize results
    const entries: CompanyResult[] = unique.map((url) => ({
      url,
      domain: getDomain(url),
      status: "idle" as const,
      error: null,
      scrape: null,
      history: null,
      details: null,
    }));

    // Check cache for each entry
    for (const entry of entries) {
      const cached = getCachedResult(entry.domain);
      if (cached) {
        entry.status = "done";
        entry.scrape = cached.scrape;
        entry.history = cached.history;
        entry.details = cached.details;
      }
    }

    setResults(entries);

    // Run pipeline for non-cached entries sequentially
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].status === "done") continue; // skip cached
      setActiveTab(i);
      await runPipeline(entries[i], i);
    }

    setIsRunning(false);
  }

  async function handleReanalyze(index: number) {
    setIsRunning(true);
    setActiveTab(index);

    // Reset this entry
    updateResult(index, {
      status: "idle",
      error: null,
      scrape: null,
      history: null,
      details: null,
    });

    // Small delay for state to update
    await new Promise((r) => setTimeout(r, 50));

    // Get the fresh entry
    let entry: CompanyResult | null = null;
    setResults((prev) => {
      entry = prev[index];
      return prev;
    });

    if (entry) {
      await runPipeline(entry, index);
    }

    setIsRunning(false);
  }

  function clearResults() {
    setResults([]);
    setActiveTab(0);
  }

  function copyToClipboard(text: string, idx: number) {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  // Get the current step label for progress display
  function getStepLabel(status: string): string {
    switch (status) {
      case "scraping":
        return "Scraping website & extracting products...";
      case "history":
        return "Searching Wayback Machine for historical data...";
      case "details":
        return "Finding address & generating outreach...";
      default:
        return "";
    }
  }

  const currentResults = results[activeTab] || null;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg shrink-0"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-4">
          <img
            src="/valstone-logo.png"
            alt="Valstone"
            className="h-8 w-auto rounded"
          />
          <a
            href="/"
            className="text-sm text-gray-300 hover:text-white transition-colors"
          >
            &larr; Back
          </a>
        </div>
        <button
          onClick={handleLogout}
          className="text-gray-300 hover:text-white text-sm"
        >
          Sign out
        </button>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────── */}
      <main className="flex-1 px-8 py-8 max-w-7xl mx-auto w-full">
        <h1 className="text-2xl font-semibold text-navy mb-1">Sourcing Tool</h1>
        <p className="text-sm text-gray-400 mb-6">
          Research companies, match to portfolio groups, and generate
          personalized outreach
        </p>

        {/* ── URL Inputs ─────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
          <div className="space-y-3">
            {Array.from({ length: urlCount }).map((_, i) => (
              <div key={i}>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                  {urlCount === 1 ? "Company URL" : `Company URL ${i + 1}`}
                </label>
                <input
                  type="text"
                  value={urls[i] || ""}
                  onChange={(e) => handleUrlChange(i, e.target.value)}
                  placeholder="https://www.example.com"
                  disabled={isRunning}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400 disabled:bg-gray-50 disabled:text-gray-400"
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-4">
            {urlCount < 5 && (
              <button
                onClick={addUrlField}
                disabled={isRunning}
                className="text-sm text-gray-500 hover:text-violet-600 border border-dashed border-gray-300 hover:border-violet-400 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                + Add another URL
              </button>
            )}

            <button
              onClick={handleRun}
              disabled={isRunning || urls.every((u) => !u.trim())}
              className="ml-auto px-6 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold rounded-full shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRunning ? "Running..." : "Run Scout"}
            </button>
          </div>
        </div>

        {/* ── Results ────────────────────────────────────────────────── */}
        {results.length > 0 && (
          <div>
            {/* Results header + clear button */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-navy">Results</h2>
              {!isRunning && (
                <button
                  onClick={clearResults}
                  className="text-sm text-gray-400 hover:text-red-500 border border-dashed border-gray-300 hover:border-red-300 px-3 py-1 rounded-lg transition-colors"
                >
                  Clear Results
                </button>
              )}
            </div>

            {/* Tabs (for multiple companies) */}
            {results.length > 1 && (
              <div className="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1">
                {results.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveTab(i)}
                    className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                      activeTab === i
                        ? "bg-white text-navy font-medium shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {r.domain}
                    {r.status === "done" && (
                      <span className="ml-1.5 text-green-500">&#10003;</span>
                    )}
                    {r.status === "error" && (
                      <span className="ml-1.5 text-red-500">&#10007;</span>
                    )}
                    {r.status !== "done" &&
                      r.status !== "error" &&
                      r.status !== "idle" && (
                        <span className="ml-1.5 animate-pulse text-violet-500">
                          &#9679;
                        </span>
                      )}
                  </button>
                ))}
              </div>
            )}

            {/* Current company results */}
            {currentResults && (
              <div>
                {/* Progress indicator */}
                {currentResults.status !== "done" &&
                  currentResults.status !== "error" &&
                  currentResults.status !== "idle" && (
                    <div className="bg-violet-50 border border-violet-200 rounded-xl p-4 mb-4 flex items-center gap-3">
                      <div className="w-5 h-5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm text-violet-700 font-medium">
                        {getStepLabel(currentResults.status)}
                      </span>
                    </div>
                  )}

                {/* Error */}
                {currentResults.status === "error" && (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
                    <p className="text-sm text-red-700">
                      <strong>Error:</strong> {currentResults.error}
                    </p>
                  </div>
                )}

                {/* Cached indicator + re-analyze button */}
                {currentResults.status === "done" && !isRunning && (
                  <div className="flex items-center gap-2 mb-4">
                    <button
                      onClick={() => handleReanalyze(activeTab)}
                      className="text-xs text-gray-400 hover:text-violet-600 border border-dashed border-gray-300 hover:border-violet-400 px-2.5 py-1 rounded-lg transition-colors"
                    >
                      &#8635; Re-analyze
                    </button>
                  </div>
                )}

                {/* Three-column results */}
                {currentResults.scrape && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    {/* Column 1: Portfolio Group */}
                    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                      <h3 className="text-xs font-semibold text-violet-600 uppercase tracking-wide mb-3 pb-2 border-b border-gray-100">
                        Portfolio Group
                      </h3>
                      {currentResults.scrape.portfolioMatch.matched ? (
                        <p className="text-xl font-bold text-navy">
                          {currentResults.scrape.portfolioMatch.group}
                        </p>
                      ) : (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                          <p className="text-sm text-amber-700">
                            No match — this company does not fit any current
                            portfolio group.
                          </p>
                        </div>
                      )}

                      {/* Products list */}
                      {currentResults.scrape.products.length > 0 && (
                        <div className="mt-4">
                          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                            Products Found
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {currentResults.scrape.products
                              .slice(0, 8)
                              .map((p, i) => (
                                <span
                                  key={i}
                                  className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full"
                                >
                                  {p}
                                </span>
                              ))}
                            {currentResults.scrape.products.length > 8 && (
                              <span className="text-xs text-gray-400">
                                +{currentResults.scrape.products.length - 8}{" "}
                                more
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Column 2: Discontinued Product */}
                    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                      <h3 className="text-xs font-semibold text-violet-600 uppercase tracking-wide mb-3 pb-2 border-b border-gray-100">
                        Discontinued Product
                      </h3>

                      {currentResults.scrape.foundingYear && (
                        <p className="text-xs text-gray-400 mb-2">
                          Est. founded:{" "}
                          {currentResults.scrape.foundingYear}
                          {currentResults.scrape.foundingYear > 2016 && (
                            <span className="ml-2 text-amber-600 font-medium">
                              — verify age before reaching out
                            </span>
                          )}
                        </p>
                      )}

                      {currentResults.status === "history" && (
                        <p className="text-sm text-gray-400 italic">
                          Searching Wayback Machine...
                        </p>
                      )}

                      {currentResults.history ? (
                        currentResults.history.discontinued ? (
                          <div>
                            <p className="text-lg font-semibold text-navy">
                              {currentResults.history.discontinued}
                            </p>
                            {currentResults.history.discontinuedNote && (
                              <p className="text-xs text-gray-400 mt-1">
                                {currentResults.history.discontinuedNote}
                              </p>
                            )}
                            {currentResults.history.archiveUrl && (
                              <a
                                href={currentResults.history.archiveUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block mt-2 text-xs text-violet-600 hover:text-violet-800 underline"
                              >
                                View archived page &rarr;
                              </a>
                            )}
                          </div>
                        ) : (
                          <div>
                            <p className="text-sm text-gray-500">
                              None identified.
                            </p>
                            {!currentResults.history.archiveUrl && (
                              <p className="text-xs text-gray-400 mt-1">
                                No valid Wayback Machine snapshot found for the{" "}
                                {currentResults.history.wbLabel} window.
                              </p>
                            )}
                          </div>
                        )
                      ) : currentResults.status === "done" ? (
                        <p className="text-sm text-gray-500">
                          No historical data available.
                        </p>
                      ) : null}
                    </div>

                    {/* Column 3: Outreach Paragraph */}
                    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                      <h3 className="text-xs font-semibold text-violet-600 uppercase tracking-wide mb-3 pb-2 border-b border-gray-100">
                        Outreach Paragraph
                      </h3>

                      {currentResults.status === "details" && (
                        <p className="text-sm text-gray-400 italic">
                          Generating outreach...
                        </p>
                      )}

                      {currentResults.details?.outreachParagraph ? (
                        <div>
                          <p className="text-sm text-gray-700 leading-relaxed">
                            {currentResults.details.outreachParagraph}
                          </p>
                          <button
                            onClick={() =>
                              copyToClipboard(
                                currentResults.details!.outreachParagraph!,
                                activeTab
                              )
                            }
                            className="mt-3 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-full shadow-sm hover:shadow-md transition-all"
                          >
                            {copiedIdx === activeTab
                              ? "Copied!"
                              : "Copy to Clipboard"}
                          </button>
                        </div>
                      ) : currentResults.status === "done" ? (
                        <p className="text-sm text-gray-500">
                          {currentResults.scrape?.portfolioMatch.matched
                            ? "Outreach paragraph could not be generated."
                            : "No outreach paragraph — no portfolio group match."}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}

                {/* Restaurant Recommendations */}
                {currentResults.details && currentResults.details.address && (
                  <div className="mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <h3 className="text-xs font-semibold text-violet-600 uppercase tracking-wide">
                        Nearby Restaurants
                      </h3>
                      <span className="text-sm text-gray-500">
                        — {currentResults.details.address}
                      </span>
                    </div>

                    {currentResults.details.restaurants.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {currentResults.details.restaurants.map((r, i) => (
                          <div
                            key={i}
                            className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5"
                          >
                            <p className="text-xs font-semibold text-violet-600 uppercase tracking-wide mb-2">
                              Business Dinner
                            </p>
                            <p className="font-semibold text-navy mb-1">
                              {r.name}
                            </p>
                            <p className="text-sm text-gray-500">
                              {r.description}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-400">
                        Restaurant recommendations could not be retrieved for
                        this address.
                      </p>
                    )}
                  </div>
                )}

                {currentResults.status === "done" &&
                  currentResults.details &&
                  !currentResults.details.address && (
                    <p className="text-sm text-gray-400 mb-6">
                      No company address found — restaurant recommendations
                      skipped.
                    </p>
                  )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
