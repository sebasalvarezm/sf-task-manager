"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import WeekSelector, {
  WeekRange,
  generateWeeks,
  currentWeekIndex,
} from "../../components/WeekSelector";
import ConnectSalesforce from "../../components/ConnectSalesforce";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";

// ── One-pager localStorage cache ─────────────────────────────────────────────
const PREP_CACHE_KEY = "call_prep_cache";

function getOnePagerCache(): Record<string, OnePagerContent> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PREP_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveOnePagerToCache(key: string, onePager: OnePagerContent) {
  if (typeof window === "undefined") return;
  try {
    const cache = getOnePagerCache();
    cache[key] = onePager;
    localStorage.setItem(PREP_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable — non-critical
  }
}

function getCacheKey(meeting: MeetingMatch): string | null {
  if (meeting.match) return meeting.match.accountId;
  if (meeting.externalDomains.length > 0) return meeting.externalDomains[0];
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────

type MeetingMatch = {
  eventId: string;
  subject: string;
  meetingDate: string;
  startTime: string;
  externalDomains: string[];
  match: {
    accountId: string;
    accountName: string;
    accountUrl: string;
  } | null;
  allMatches: Array<{
    accountId: string;
    accountName: string;
    accountUrl: string;
    domain: string;
  }>;
  alreadyLogged: boolean;
};

type OnePagerContent = {
  companyName: string;
  whatTheyDo: string;
  customers: string;
  companyHistory: string;
  recentNews: string[];
};

type PrepMeeting = MeetingMatch & {
  onePager: OnePagerContent | null;
  generating: boolean;
  generateError: string | null;
  downloading: boolean;
};

// ── Page wrapper ─────────────────────────────────────────────────────────────

export default function PrepPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-navy" />}>
      <PrepPageContent />
    </Suspense>
  );
}

// ── Main page content ────────────────────────────────────────────────────────

function PrepPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Connection state
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [msConnected, setMsConnected] = useState<boolean | null>(null);

  // Week & meetings
  const [selectedWeek, setSelectedWeek] = useState<WeekRange | null>(
    () => generateWeeks()[currentWeekIndex()]
  );
  const [meetings, setMeetings] = useState<PrepMeeting[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Expanded row (to show one-pager preview)
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Manual Salesforce account search (for unmatched meetings)
  const [manualMatches, setManualMatches] = useState<
    Map<string, { accountId: string; accountName: string; accountUrl: string }>
  >(new Map());
  const [searchInputs, setSearchInputs] = useState<Map<string, string>>(
    new Map()
  );
  const [searchResults, setSearchResults] = useState<
    Map<
      string,
      Array<{
        accountId: string;
        accountName: string;
        accountUrl: string;
        website: string | null;
      }>
    >
  >(new Map());
  const [searchLoading, setSearchLoading] = useState<Set<string>>(new Set());

  // ── On mount: check connections ────────────────────────────────────────────
  useEffect(() => {
    const msOk = searchParams.get("ms_connected");
    const msErr = searchParams.get("ms_error");
    if (msOk || msErr) {
      router.replace("/prep");
    }
    checkConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkConnections() {
    try {
      const [sfRes, msRes] = await Promise.all([
        fetch("/api/salesforce/status"),
        fetch("/api/microsoft/status"),
      ]);
      if (sfRes.ok) {
        const sfData = await sfRes.json();
        setSfConnected(sfData.connected);
      }
      if (msRes.ok) {
        const msData = await msRes.json();
        setMsConnected(msData.connected);
      }
    } catch {
      setSfConnected(false);
      setMsConnected(false);
    }
  }

  // ── Load meetings for selected week ────────────────────────────────────────
  async function handleLoad() {
    if (!selectedWeek) return;

    setLoading(true);
    setLoadError(null);
    setMeetings([]);
    setHasLoaded(false);
    setExpandedId(null);

    try {
      const res = await fetch(
        `/api/microsoft/calendar?start=${selectedWeek.start}&end=${selectedWeek.end}`
      );

      if (!res.ok) {
        const err = await res.json();
        if (err.error === "MS_NOT_CONNECTED") {
          setMsConnected(false);
          throw new Error("Outlook is not connected. Please connect first.");
        }
        throw new Error(err.error ?? "Failed to fetch calendar");
      }

      const data = await res.json();
      const raw: MeetingMatch[] = data.meetings ?? [];
      const cache = getOnePagerCache();

      // Wrap each meeting with prep-specific state, restoring cached one-pagers
      setMeetings(
        raw.map((m) => {
          const key = getCacheKey(m);
          const cached = key ? cache[key] ?? null : null;
          return {
            ...m,
            onePager: cached,
            generating: false,
            generateError: null,
            downloading: false,
          };
        })
      );
      setHasLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  // ── Generate one-pager for a meeting ───────────────────────────────────────
  async function handleGenerate(eventId: string) {
    const meeting = meetings.find((m) => m.eventId === eventId);
    if (!meeting) return;

    // Update state to show loading
    setMeetings((prev) =>
      prev.map((m) =>
        m.eventId === eventId
          ? { ...m, generating: true, generateError: null }
          : m
      )
    );

    try {
      const payload: Record<string, string> = {};

      // Use Salesforce account data if matched (auto or manual)
      const sfMatch = meeting.match ?? manualMatches.get(meeting.eventId);
      if (sfMatch) {
        payload.accountId = sfMatch.accountId;
        payload.accountName = sfMatch.accountName;
      }

      // Use website or domain for scraping + research
      const matchWithWebsite = meeting.allMatches.find((m) => m.domain);
      if (matchWithWebsite) {
        payload.domain = matchWithWebsite.domain;
      } else if (meeting.externalDomains.length > 0) {
        payload.domain = meeting.externalDomains[0];
      }

      // Fallback: use the Salesforce account URL (needed for manually linked accounts
      // where meeting.allMatches is empty and no domain was found above)
      if (!payload.domain && !payload.website && sfMatch?.accountUrl) {
        payload.website = sfMatch.accountUrl;
      }

      const res = await fetch("/api/prep/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Generation failed");
      }

      const data = await res.json();
      const onePager: OnePagerContent = data.onePager;

      setMeetings((prev) =>
        prev.map((m) =>
          m.eventId === eventId
            ? { ...m, onePager, generating: false }
            : m
        )
      );

      // Save to localStorage cache
      const cacheKey = getCacheKey(meeting);
      if (cacheKey && onePager) {
        saveOnePagerToCache(cacheKey, onePager);
      }

      // Auto-expand the row to show preview
      setExpandedId(eventId);
    } catch (err) {
      setMeetings((prev) =>
        prev.map((m) =>
          m.eventId === eventId
            ? {
                ...m,
                generating: false,
                generateError:
                  err instanceof Error ? err.message : "Unexpected error",
              }
            : m
        )
      );
    }
  }

  // ── Download one-pager as Word doc ─────────────────────────────────────────
  async function handleDownload(eventId: string) {
    const meeting = meetings.find((m) => m.eventId === eventId);
    if (!meeting?.onePager) return;

    setMeetings((prev) =>
      prev.map((m) =>
        m.eventId === eventId ? { ...m, downloading: true } : m
      )
    );

    try {
      const res = await fetch("/api/prep/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meeting.onePager),
      });

      if (!res.ok) throw new Error("Download failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Call Prep - ${meeting.onePager.companyName}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Silently fail — button state will reset
    } finally {
      setMeetings((prev) =>
        prev.map((m) =>
          m.eventId === eventId ? { ...m, downloading: false } : m
        )
      );
    }
  }

  // ── Disconnect handlers ────────────────────────────────────────────────────
  async function handleSfDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setSfConnected(false);
  }

  async function handleMsDisconnect() {
    await fetch("/api/microsoft/status", { method: "DELETE" });
    setMsConnected(false);
    setMeetings([]);
    setHasLoaded(false);
  }

  // ── Manual Salesforce account search ──────────────────────────────────────
  async function handleAccountSearch(eventId: string) {
    const query = searchInputs.get(eventId)?.trim();
    if (!query || query.length < 2) return;

    setSearchLoading((prev) => new Set(prev).add(eventId));
    try {
      const res = await fetch(
        `/api/salesforce/search-accounts?q=${encodeURIComponent(query)}`
      );
      if (res.ok) {
        const data = await res.json();
        setSearchResults(
          (prev) => new Map(prev).set(eventId, data.accounts ?? [])
        );
      }
    } finally {
      setSearchLoading((prev) => {
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
    }
  }

  function handleSelectSearchResult(
    eventId: string,
    account: { accountId: string; accountName: string; accountUrl: string }
  ) {
    setManualMatches((prev) => new Map(prev).set(eventId, account));
    setSearchResults((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
    setSearchInputs((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
  }

  const msReady = msConnected === true;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Call Prep"
        actions={
          <>
            {msConnected === true ? (
              <button
                onClick={handleMsDisconnect}
                className="inline-flex items-center gap-2 text-sm text-ok bg-ok-soft border border-ok/20 rounded-md px-3 h-9 hover:bg-ok-soft/70 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-ok" />
                Outlook
              </button>
            ) : msConnected === false ? (
              <a
                href="/api/microsoft/connect"
                className="inline-flex items-center gap-2 bg-info hover:bg-info/90 text-white text-sm font-medium px-4 h-9 rounded-md transition-colors"
              >
                Connect Outlook
              </a>
            ) : null}
            <ConnectSalesforce
              connected={sfConnected === true}
              onDisconnect={handleSfDisconnect}
            />
          </>
        }
      />
      <PageContent>
        {/* Loading connections */}
        {(sfConnected === null || msConnected === null) && (
          <div className="flex justify-center items-center py-24">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-orange" />
          </div>
        )}

        {/* Connection prompts */}
        {msConnected === false && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center mb-6">
            <p className="text-blue-800 font-medium mb-2">
              Outlook is not connected.
            </p>
            <p className="text-blue-600 text-sm mb-4">
              Connect your Microsoft account so the app can read your calendar.
            </p>
            <a
              href="/api/microsoft/connect"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
            >
              Connect Outlook
            </a>
          </div>
        )}

        {sfConnected === false && msConnected !== false && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center mb-6">
            <p className="text-amber-800 font-medium mb-2">
              Salesforce is not connected.
            </p>
            <p className="text-amber-600 text-sm mb-4">
              Connect Salesforce for richer company data in your one-pagers. You
              can still generate briefings without it.
            </p>
            <a
              href="/api/salesforce/connect"
              className="inline-block bg-brand-orange hover:bg-brand-orange-hover text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
            >
              Connect Salesforce
            </a>
          </div>
        )}

        {/* Main UI — Outlook must be connected */}
        {msReady && (
          <>
            {/* Controls bar */}
            <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
              <div>
                <h2 className="text-xl font-semibold text-navy">Call Prep</h2>
                <p className="text-sm text-gray-400 mt-0.5">
                  Prepare one-pager briefings for your upcoming meetings
                </p>
              </div>

              <div className="flex items-center gap-4">
                <WeekSelector
                  selected={selectedWeek}
                  onChange={(week) => {
                    setSelectedWeek(week);
                    setMeetings([]);
                    setHasLoaded(false);
                    setExpandedId(null);
                  }}
                />
                <button
                  onClick={handleLoad}
                  disabled={loading}
                  className="bg-brand-orange hover:bg-brand-orange-hover disabled:opacity-50 text-white font-semibold px-6 py-2 rounded-lg transition-colors text-sm"
                >
                  {loading ? "Loading..." : "Load Meetings"}
                </button>
              </div>
            </div>

            {/* Error */}
            {loadError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 text-sm text-red-700">
                {loadError}
              </div>
            )}

            {/* Loading spinner */}
            {loading && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-orange" />
                <p className="text-sm text-gray-400">
                  Fetching calendar events and matching to Salesforce...
                </p>
              </div>
            )}

            {/* Results table */}
            {!loading && hasLoaded && (
              <>
                <div className="text-sm text-gray-400 mb-3">
                  {meetings.length} external meeting
                  {meetings.length !== 1 ? "s" : ""} found
                </div>

                {meetings.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <p className="font-medium">
                      No external meetings found for this week.
                    </p>
                    <p className="text-sm mt-1">
                      Try a different week or check that your Outlook calendar
                      has meetings with external attendees.
                    </p>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-navy text-white text-xs font-semibold uppercase tracking-wider">
                          <th className="px-4 py-3 text-left w-10">#</th>
                          <th className="px-4 py-3 text-left">Meeting</th>
                          <th className="px-4 py-3 text-left w-28">Date</th>
                          <th className="px-4 py-3 text-left">Account</th>
                          <th className="px-4 py-3 text-left w-20">SF</th>
                          <th className="px-4 py-3 text-center w-48">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {meetings.map((meeting, idx) => (
                          <MeetingRow
                            key={meeting.eventId}
                            meeting={meeting}
                            index={idx}
                            expanded={expandedId === meeting.eventId}
                            onToggleExpand={() =>
                              setExpandedId(
                                expandedId === meeting.eventId
                                  ? null
                                  : meeting.eventId
                              )
                            }
                            onGenerate={() => handleGenerate(meeting.eventId)}
                            onDownload={() => handleDownload(meeting.eventId)}
                            manualMatch={manualMatches.get(meeting.eventId) ?? null}
                            searchInput={searchInputs.get(meeting.eventId) ?? ""}
                            searchResult={searchResults.get(meeting.eventId) ?? null}
                            isSearchLoading={searchLoading.has(meeting.eventId)}
                            onSearchInputChange={(val) =>
                              setSearchInputs((prev) => new Map(prev).set(meeting.eventId, val))
                            }
                            onSearch={() => handleAccountSearch(meeting.eventId)}
                            onSelectResult={(account) =>
                              handleSelectSearchResult(meeting.eventId, account)
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {/* Prompt to load */}
            {!loading && !hasLoaded && !loadError && (
              <div className="text-center py-16 text-gray-400">
                <div className="text-5xl mb-4">
                  <svg
                    className="w-16 h-16 mx-auto text-gray-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                </div>
                <p className="font-medium">
                  Select a week and click &quot;Load Meetings&quot;
                </p>
                <p className="text-sm mt-1">
                  We&apos;ll pull your Outlook calendar and show external
                  meetings you can prepare for
                </p>
              </div>
            )}
          </>
        )}
      </PageContent>
    </>
  );
}

// ── Meeting Row Component ────────────────────────────────────────────────────

function MeetingRow({
  meeting,
  index,
  expanded,
  onToggleExpand,
  onGenerate,
  onDownload,
  manualMatch,
  searchInput,
  searchResult,
  isSearchLoading,
  onSearchInputChange,
  onSearch,
  onSelectResult,
}: {
  meeting: PrepMeeting;
  index: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onGenerate: () => void;
  onDownload: () => void;
  manualMatch: { accountId: string; accountName: string; accountUrl: string } | null;
  searchInput: string;
  searchResult: Array<{ accountId: string; accountName: string; accountUrl: string; website: string | null }> | null;
  isSearchLoading: boolean;
  onSearchInputChange: (val: string) => void;
  onSearch: () => void;
  onSelectResult: (account: { accountId: string; accountName: string; accountUrl: string }) => void;
}) {
  const hasOnePager = meeting.onePager !== null;
  const effectiveMatch = meeting.match ?? manualMatch;
  const accountName =
    effectiveMatch?.accountName || meeting.externalDomains[0] || "Unknown";

  return (
    <>
      {/* Main row */}
      <tr className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
        <td className="px-4 py-3 text-gray-400 font-mono text-xs">
          {index + 1}
        </td>
        <td className="px-4 py-3">
          <div className="font-medium text-navy">{meeting.subject}</div>
          {meeting.startTime && (
            <div className="text-xs text-gray-400 mt-0.5">
              {meeting.startTime}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-gray-600">{meeting.meetingDate}</td>
        <td className="px-4 py-3">
          {meeting.match ? (
            /* Auto-matched account */
            <span className="font-medium text-navy">{meeting.match.accountName}</span>
          ) : manualMatch ? (
            /* Manually linked account */
            <div>
              <span className="font-medium text-navy">{manualMatch.accountName}</span>
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                Manually linked
              </span>
            </div>
          ) : (
            /* No match — show search UI */
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={searchInput}
                  placeholder={meeting.externalDomains.length > 0 ? meeting.externalDomains[0].split(".")[0] : "Search account..."}
                  onChange={(e) => onSearchInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onSearch();
                    }
                  }}
                  className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                />
                <button
                  onClick={onSearch}
                  disabled={isSearchLoading}
                  className="shrink-0 bg-navy hover:bg-navy/80 disabled:opacity-50 text-white text-xs font-medium px-2 py-1 rounded transition-colors"
                >
                  {isSearchLoading ? "..." : "Search"}
                </button>
              </div>
              {meeting.externalDomains.length > 0 && !searchInput && (
                <span className="text-xs text-gray-300">
                  {meeting.externalDomains.join(", ")}
                </span>
              )}
              {/* Search results dropdown */}
              {searchResult && (
                <div className="border border-gray-200 rounded bg-white shadow-lg max-h-32 overflow-y-auto">
                  {searchResult.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-gray-400 italic">No accounts found</div>
                  ) : (
                    searchResult.map((account) => (
                      <button
                        key={account.accountId}
                        onClick={() => onSelectResult(account)}
                        className="w-full text-left px-2 py-1.5 text-sm hover:bg-blue-50 hover:text-blue-700 border-b border-gray-100 last:border-0 transition-colors"
                      >
                        {account.accountName}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </td>
        <td className="px-4 py-3">
          {effectiveMatch ? (
            <a
              href={effectiveMatch.accountUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 text-xs font-medium"
            >
              Open
            </a>
          ) : (
            <span className="text-gray-300 text-xs">—</span>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-center gap-2">
            {/* Generate button (shown when no one-pager exists) */}
            {!hasOnePager && !meeting.generating && (
              <button
                onClick={onGenerate}
                className="bg-brand-orange hover:bg-brand-orange-hover text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
              >
                Generate
              </button>
            )}

            {/* Generating spinner */}
            {meeting.generating && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-orange" />
                Generating...
              </div>
            )}

            {/* Error */}
            {meeting.generateError && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-500">
                  {meeting.generateError}
                </span>
                <button
                  onClick={onGenerate}
                  className="text-xs text-brand-orange hover:underline"
                >
                  Retry
                </button>
              </div>
            )}

            {/* After generation: Regenerate + View + Download */}
            {hasOnePager && !meeting.generating && (
              <>
                <button
                  onClick={onGenerate}
                  className="text-xs text-gray-400 hover:text-brand-orange transition-colors"
                  title="Regenerate one-pager"
                >
                  ↻
                </button>
                <button
                  onClick={onToggleExpand}
                  className="text-xs font-medium text-navy hover:text-brand-orange transition-colors px-2 py-1.5 rounded border border-gray-200 hover:border-brand-orange"
                >
                  {expanded ? "Hide" : "View"}
                </button>
                <button
                  onClick={onDownload}
                  disabled={meeting.downloading}
                  className="bg-navy hover:bg-navy-dark disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {meeting.downloading ? (
                    <>
                      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      Word
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded preview row */}
      {expanded && meeting.onePager && (
        <tr>
          <td colSpan={6} className="px-4 py-6 bg-gray-50 border-t border-gray-100">
            <div className="max-w-3xl mx-auto">
              <h3 className="text-lg font-semibold text-navy mb-4">
                {meeting.onePager.companyName}
              </h3>

              {/* What They Do */}
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  What They Do
                </h4>
                <p className="text-sm text-gray-700 leading-relaxed">
                  {meeting.onePager.whatTheyDo}
                </p>
              </div>

              {/* Customers & Use Case */}
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  Customers & Use Case
                </h4>
                <p className="text-sm text-gray-700 leading-relaxed">
                  {meeting.onePager.customers}
                </p>
              </div>

              {/* Company History */}
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  Company History
                </h4>
                <p className="text-sm text-gray-700 leading-relaxed">
                  {meeting.onePager.companyHistory}
                </p>
              </div>

              {/* Recent News */}
              <div className="mb-2">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  Recent News
                </h4>
                {meeting.onePager.recentNews.length > 0 ? (
                  <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                    {meeting.onePager.recentNews.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-400 italic">
                    No recent news found.
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
