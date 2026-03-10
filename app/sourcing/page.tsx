"use client";

import { useState, useCallback } from "react";
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
  logs?: string[];
};

type HistoryResult = {
  archiveUrl: string | null;
  archiveYear: string | null;
  wbLabel: string;
  discontinued: string | null;
  discontinuedNote: string | null;
  oldProducts: string[];
  logs?: string[];
};

type DetailsResult = {
  address: string | null;
  restaurants: { name: string; description: string }[];
  outreachParagraph: string | null;
  logs?: string[];
};

type CompanyResult = {
  url: string;
  domain: string;
  status: "idle" | "scraping" | "history" | "details" | "done" | "error";
  error: string | null;
  scrape: ScrapeResult | null;
  history: HistoryResult | null;
  details: DetailsResult | null;
  logs: string[];
};

// ---------------------------------------------------------------------------
// localStorage cache
// ---------------------------------------------------------------------------

const CACHE_KEY = "sourcing_results_cache";

type CachedResult = {
  scrape: ScrapeResult;
  history: HistoryResult | null;
  details: DetailsResult | null;
  logs: string[];
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
        currentText: result.scrape.currentText.slice(0, 500),
      },
      history: result.history,
      details: result.details,
      logs: result.logs,
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
// Step Progress Component
// ---------------------------------------------------------------------------

const STEPS = [
  { key: "scraping", label: "Scraping website & extracting products" },
  { key: "history", label: "Searching Wayback Machine for history" },
  { key: "details", label: "Finding address & generating outreach" },
];

function StepProgress({ status }: { status: string }) {
  const stepOrder = ["scraping", "history", "details", "done"];
  const currentIdx = stepOrder.indexOf(status);

  return (
    <div className="flex flex-col gap-2 bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-5">
      {STEPS.map((step, i) => {
        const isDone = currentIdx > i || status === "done";
        const isActive = status === step.key;

        return (
          <div key={step.key} className="flex items-center gap-3">
            {isDone ? (
              <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            ) : isActive ? (
              <div className="w-6 h-6 rounded-full border-2 border-[#E84C0E] border-t-transparent animate-spin shrink-0" />
            ) : (
              <div className="w-6 h-6 rounded-full border-2 border-gray-200 shrink-0" />
            )}
            <span
              className={`text-sm ${
                isDone
                  ? "text-green-700 font-medium"
                  : isActive
                  ? "text-[#1B2A4A] font-semibold"
                  : "text-gray-400"
              }`}
            >
              {step.label}
              {isActive && (
                <span className="ml-1 text-[#E84C0E] animate-pulse">...</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log Panel Component
// ---------------------------------------------------------------------------

function LogPanel({
  logs,
  isRunning,
}: {
  logs: string[];
  isRunning: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  if (logs.length === 0) return null;

  return (
    <div className="mb-5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-medium text-gray-500 hover:text-[#1B2A4A] uppercase tracking-wide mb-2 transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {isRunning ? "Analysis Log" : "View Analysis Log"}
        <span className="text-gray-400 normal-case tracking-normal">
          ({logs.length} steps)
        </span>
      </button>

      {expanded && (
        <div className="bg-[#141f38] rounded-xl p-4 border border-[#253561] overflow-auto max-h-64">
          {logs.map((log, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5 last:mb-0">
              <span className="text-[#E84C0E] text-xs mt-0.5 shrink-0 font-mono">
                {">"}
              </span>
              <span className="text-gray-300 text-xs font-mono leading-relaxed">
                {log}
              </span>
            </div>
          ))}
          {isRunning && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[#E84C0E] text-xs font-mono">{">"}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#E84C0E] animate-pulse" />
            </div>
          )}
        </div>
      )}
    </div>
  );
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
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
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

  const appendLogs = useCallback(
    (index: number, newLogs: string[]) => {
      setResults((prev) => {
        const copy = [...prev];
        copy[index] = {
          ...copy[index],
          logs: [...copy[index].logs, ...newLogs],
        };
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
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      if (data.logs) appendLogs(index, data.logs);
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
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      if (data.logs) appendLogs(index, data.logs);
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
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      if (data.logs) appendLogs(index, data.logs);
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
    const validUrls = urls
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((u) => (u.startsWith("http") ? u : `https://${u}`));

    const unique = [...new Set(validUrls)];
    if (unique.length === 0) return;

    setIsRunning(true);
    setActiveTab(0);

    const entries: CompanyResult[] = unique.map((url) => ({
      url,
      domain: getDomain(url),
      status: "idle" as const,
      error: null,
      scrape: null,
      history: null,
      details: null,
      logs: [],
    }));

    // Check cache
    for (const entry of entries) {
      const cached = getCachedResult(entry.domain);
      if (cached) {
        entry.status = "done";
        entry.scrape = cached.scrape;
        entry.history = cached.history;
        entry.details = cached.details;
        entry.logs = cached.logs || [];
      }
    }

    setResults(entries);

    for (let i = 0; i < entries.length; i++) {
      if (entries[i].status === "done") continue;
      setActiveTab(i);
      await runPipeline(entries[i], i);
    }

    setIsRunning(false);
  }

  async function handleReanalyze(index: number) {
    setIsRunning(true);
    setActiveTab(index);

    updateResult(index, {
      status: "idle",
      error: null,
      scrape: null,
      history: null,
      details: null,
      logs: [],
    });

    await new Promise((r) => setTimeout(r, 50));

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

  const currentResults = results[activeTab] || null;
  const isCurrentRunning =
    currentResults != null &&
    currentResults.status !== "done" &&
    currentResults.status !== "error" &&
    currentResults.status !== "idle";

  return (
    <div className="min-h-screen flex flex-col bg-[#f0f2f5]">
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
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-semibold text-[#1B2A4A]">
            Sourcing Tool
          </h1>
          <span className="text-[10px] font-bold uppercase tracking-widest text-white bg-gradient-to-r from-[#E84C0E] to-[#c93d09] px-2 py-0.5 rounded-full">
            Scout
          </span>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          Research companies, match to portfolio groups, and generate
          personalized outreach
        </p>

        {/* ── URL Inputs ─────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-md p-6 mb-6">
          <div className="space-y-3">
            {Array.from({ length: urlCount }).map((_, i) => (
              <div key={i}>
                <label className="block text-xs font-semibold text-[#1B2A4A] uppercase tracking-wide mb-1.5">
                  {urlCount === 1 ? "Company URL" : `Company URL ${i + 1}`}
                </label>
                <input
                  type="text"
                  value={urls[i] || ""}
                  onChange={(e) => handleUrlChange(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isRunning && urls.some((u) => u.trim())) {
                      e.preventDefault();
                      handleRun();
                    }
                  }}
                  placeholder="https://www.example.com"
                  disabled={isRunning}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 focus:border-[#E84C0E] disabled:bg-gray-50 disabled:text-gray-400 transition-all"
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-4">
            {urlCount < 5 && (
              <button
                onClick={addUrlField}
                disabled={isRunning}
                className="text-sm text-gray-500 hover:text-[#1B2A4A] border border-dashed border-gray-300 hover:border-[#1B2A4A] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              >
                + Add another URL
              </button>
            )}

            <button
              onClick={handleRun}
              disabled={isRunning || urls.every((u) => !u.trim())}
              className="ml-auto px-7 py-2.5 bg-gradient-to-r from-[#E84C0E] to-[#c93d09] hover:from-[#c93d09] hover:to-[#a83308] text-white text-sm font-semibold rounded-full shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-md"
            >
              {isRunning ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Running...
                </span>
              ) : (
                "Run Scout"
              )}
            </button>
          </div>
        </div>

        {/* ── Results ────────────────────────────────────────────────── */}
        {results.length > 0 && (
          <div>
            {/* Results header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[#1B2A4A] flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#E84C0E]" />
                Results
              </h2>
              {!isRunning && (
                <button
                  onClick={clearResults}
                  className="text-xs text-gray-400 hover:text-red-500 border border-gray-200 hover:border-red-300 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Clear Results
                </button>
              )}
            </div>

            {/* Tabs */}
            {results.length > 1 && (
              <div className="flex gap-0.5 mb-4 bg-gray-100 rounded-xl p-1 shadow-inner">
                {results.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveTab(i)}
                    className={`px-4 py-2 text-sm rounded-lg transition-all ${
                      activeTab === i
                        ? "bg-[#1B2A4A] text-white font-medium shadow-md"
                        : "text-gray-500 hover:text-[#1B2A4A] hover:bg-white"
                    }`}
                  >
                    {r.domain}
                    {r.status === "done" && (
                      <span className="ml-1.5 text-green-400">&#10003;</span>
                    )}
                    {r.status === "error" && (
                      <span className="ml-1.5 text-red-400">&#10007;</span>
                    )}
                    {r.status !== "done" &&
                      r.status !== "error" &&
                      r.status !== "idle" && (
                        <span className="ml-1.5 animate-pulse text-[#E84C0E]">
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
                {/* Step Progress Tracker */}
                {isCurrentRunning && (
                  <StepProgress status={currentResults.status} />
                )}

                {/* Error */}
                {currentResults.status === "error" && (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-5">
                    <p className="text-sm text-red-700">
                      <strong>Error:</strong> {currentResults.error}
                    </p>
                  </div>
                )}

                {/* Log Panel */}
                <LogPanel
                  logs={currentResults.logs}
                  isRunning={isCurrentRunning}
                />

                {/* Re-analyze button */}
                {currentResults.status === "done" && !isRunning && (
                  <div className="flex items-center gap-2 mb-4">
                    <button
                      onClick={() => handleReanalyze(activeTab)}
                      className="text-xs text-gray-400 hover:text-[#E84C0E] border border-gray-200 hover:border-[#E84C0E] px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Re-analyze
                    </button>
                  </div>
                )}

                {/* Three-column results */}
                {currentResults.scrape && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    {/* Column 1: Portfolio Group */}
                    <div className="bg-white rounded-2xl border border-gray-200 border-t-2 border-t-[#E84C0E] shadow-md hover:shadow-lg transition-all p-6">
                      <h3 className="text-xs font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3 pb-2 border-b border-gray-100 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#E84C0E]" />
                        Portfolio Group
                      </h3>
                      {currentResults.scrape.portfolioMatch.matched ? (
                        <p className="text-xl font-bold text-[#1B2A4A]">
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
                                  className="text-xs bg-blue-50 text-[#1B2A4A] border border-blue-100 px-2 py-0.5 rounded-full"
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
                    <div className="bg-white rounded-2xl border border-gray-200 border-t-2 border-t-[#1B2A4A] shadow-md hover:shadow-lg transition-all p-6">
                      <h3 className="text-xs font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3 pb-2 border-b border-gray-100 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#1B2A4A]" />
                        Discontinued Product
                      </h3>

                      {currentResults.scrape.foundingYear && (
                        <p className="text-xs text-gray-400 mb-2">
                          Est. founded:{" "}
                          <span className="font-semibold text-[#1B2A4A]">
                            {currentResults.scrape.foundingYear}
                          </span>
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
                            <p className="text-lg font-semibold text-[#1B2A4A]">
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
                                className="inline-block mt-2 text-xs text-[#E84C0E] hover:text-[#c93d09] font-medium underline underline-offset-2"
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
                    <div className="bg-white rounded-2xl border border-gray-200 border-t-2 border-t-[#E84C0E] shadow-md hover:shadow-lg transition-all p-6">
                      <h3 className="text-xs font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3 pb-2 border-b border-gray-100 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#E84C0E]" />
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
                            className={`mt-4 px-5 py-2 text-xs font-semibold rounded-full shadow-sm hover:shadow-md transition-all ${
                              copiedIdx === activeTab
                                ? "bg-green-500 text-white"
                                : "bg-gradient-to-r from-[#E84C0E] to-[#c93d09] hover:from-[#c93d09] hover:to-[#a83308] text-white"
                            }`}
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
                    <h3 className="text-xs font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#E84C0E]" />
                      Nearby Restaurants
                      <span className="text-gray-400 normal-case tracking-normal font-normal">
                        — {currentResults.details.address}
                      </span>
                    </h3>

                    {currentResults.details.restaurants.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {currentResults.details.restaurants.map((r, i) => (
                          <div
                            key={i}
                            className="bg-white rounded-2xl border border-gray-200 shadow-md hover:shadow-lg transition-all p-5"
                          >
                            <p className="text-xs font-semibold text-[#E84C0E] uppercase tracking-wide mb-2">
                              Business Dinner
                            </p>
                            <p className="font-semibold text-[#1B2A4A] mb-1">
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
