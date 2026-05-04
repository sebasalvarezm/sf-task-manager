"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { useJobs } from "@/app/hooks/useJobs";

// ── Types ────────────────────────────────────────────────────────────────────

type SearchResult = {
  accountId: string;
  accountName: string;
  ownerName: string;
  address: string;
  addressSource: string;
  distanceMiles: number;
  durationMinutes: number | null;
  durationText: string | null;
  website: string | null;
  sfUrl: string;
  lastActivityDate: string | null;
  lat: number;
  lng: number;
};

type DiscoveredCompany = {
  name: string;
  website: string | null;
  description: string;
  subVertical: string;
  city: string | null;
  state: string | null;
  employeesEstimate: number | null;
  ownership: "independent" | "pe_vc" | "aggregator";
  ownershipDetail: string | null;
  lat: number | null;
  lng: number | null;
  straightLineMiles: number | null;
  distanceMiles: number | null;
  durationMinutes: number | null;
  durationText: string | null;
};

type UserLocation = { lat: number; lng: number; formattedAddress: string };

// ── Component ────────────────────────────────────────────────────────────────

export default function TripPage() {
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [location, setLocation] = useState("");
  const [radius, setRadius] = useState(150);

  // Existing accounts
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [userLoc, setUserLoc] = useState<UserLocation | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Discovery
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredCompany[] | null>(
    null
  );
  const [discoveryStats, setDiscoveryStats] = useState<{
    searched: number;
    found: number;
    filteredByGeo: number;
    deduped: number;
    final: number;
  } | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Scan
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{
    total: number;
    cached: number;
    remaining: number;
  } | null>(null);
  const [scanDone, setScanDone] = useState(false);

  // Uncached warning
  const [uncachedCount, setUncachedCount] = useState(0);

  // Tab
  const [activeTab, setActiveTab] = useState<"existing" | "discover">(
    "existing"
  );

  // Check SF connection
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/salesforce/status");
        if (res.ok) {
          const d = await res.json();
          setSfConnected(d.connected);
        }
      } catch {
        setSfConnected(false);
      }
    })();
  }, []);

  // ── Job-backed sync ────────────────────────────────────────────────────
  // Searches and Scans now run server-side via Inngest. The local state
  // (searching/results/etc.) is hydrated from the latest job of each kind
  // — so closing the browser and coming back automatically re-renders the
  // last result, and starting a job in one tab is reflected here.
  const { jobs, refetch: refetchJobs } = useJobs();
  const syncedTripSearchId = useRef<string | null>(null);
  const syncedTripGeocodeId = useRef<string | null>(null);

  // Trip search sync
  useEffect(() => {
    const latest = jobs.find((j) => j.kind === "trip_search");
    if (!latest) return;

    if (latest.status === "queued" || latest.status === "running") {
      setSearching(true);
      setDiscovering(true);
      return;
    }

    if (latest.id === syncedTripSearchId.current) return;
    syncedTripSearchId.current = latest.id;

    if (latest.status === "succeeded") {
      const r = (latest.result ?? {}) as {
        results?: SearchResult[];
        userLocation?: UserLocation | null;
        geocodeStats?: { uncached?: number };
        discovered?: DiscoveredCompany[] | null;
        discoveryStats?: typeof discoveryStats;
        discoveryError?: string | null;
      };
      setResults(r.results ?? []);
      setUserLoc(r.userLocation ?? null);
      setUncachedCount(r.geocodeStats?.uncached ?? 0);
      setDiscovered(r.discovered ?? null);
      setDiscoveryStats(r.discoveryStats ?? null);
      setDiscoveryError(r.discoveryError ?? null);
      setSearching(false);
      setDiscovering(false);
      setSearchError(null);
    } else if (latest.status === "failed" || latest.status === "cancelled") {
      setSearchError(latest.error || "Search failed");
      setSearching(false);
      setDiscovering(false);
    }
  }, [jobs]);

  // Trip geocode (Scan) sync
  useEffect(() => {
    const latest = jobs.find((j) => j.kind === "trip_geocode");
    if (!latest) return;

    if (latest.status === "queued" || latest.status === "running") {
      setScanning(true);
      setScanDone(false);
      const pct = latest.progress?.pct;
      const stepLabel = latest.progress?.step;
      // Best-effort progress: parse "N remaining" from step label
      const remainingMatch = stepLabel?.match(/(\d+)\s+remaining/);
      if (remainingMatch && pct != null) {
        setScanProgress({
          total: 0,
          cached: 0,
          remaining: parseInt(remainingMatch[1], 10),
        });
      }
      return;
    }

    if (latest.id === syncedTripGeocodeId.current) return;
    syncedTripGeocodeId.current = latest.id;

    if (latest.status === "succeeded") {
      const r = (latest.result ?? {}) as { total?: number };
      setScanProgress({
        total: r.total ?? 0,
        cached: r.total ?? 0,
        remaining: 0,
      });
      setScanDone(true);
      setScanning(false);
      setUncachedCount(0);
    } else if (latest.status === "failed" || latest.status === "cancelled") {
      setScanning(false);
      setScanDone(false);
    }
  }, [jobs]);

  // ── Search handler ─────────────────────────────────────────────────────

  async function handleSearch() {
    if (!location.trim()) return;

    setSearching(true);
    setDiscovering(true);
    setSearchError(null);
    setResults(null);
    setDiscovered(null);
    setDiscoveryStats(null);
    setDiscoveryError(null);

    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "trip_search",
          input: {
            location: location.trim(),
            radiusMiles: radius,
          },
          label: `Trip search: ${location.trim()}`,
          resultRoute: `/trip?jobId={jobId}`,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSearchError(data.error || "Failed to start search");
        setSearching(false);
        setDiscovering(false);
      } else {
        // Force an immediate poll so the new "running" job shows up fast
        refetchJobs();
      }
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : "Network error");
      setSearching(false);
      setDiscovering(false);
    }
  }

  // ── Cancel handlers ────────────────────────────────────────────────────

  async function handleCancelSearch() {
    const stuck = jobs.find(
      (j) =>
        j.kind === "trip_search" &&
        (j.status === "queued" || j.status === "running"),
    );
    setSearching(false);
    setDiscovering(false);
    setSearchError(null);
    if (stuck) {
      try {
        await fetch(`/api/jobs/${stuck.id}`, { method: "DELETE" });
      } catch {
        /* ignore — local state is already unblocked */
      }
      refetchJobs();
    }
  }

  async function handleCancelScan() {
    const stuck = jobs.find(
      (j) =>
        j.kind === "trip_geocode" &&
        (j.status === "queued" || j.status === "running"),
    );
    setScanning(false);
    setScanDone(false);
    if (stuck) {
      try {
        await fetch(`/api/jobs/${stuck.id}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
      refetchJobs();
    }
  }

  // ── Scan handler ───────────────────────────────────────────────────────

  async function handleScan() {
    setScanning(true);
    setScanDone(false);
    setScanProgress(null);

    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "trip_geocode",
          input: {},
          label: "Trip Planner: scan all accounts",
          resultRoute: "/trip",
        }),
      });
      if (!res.ok) {
        setScanning(false);
      } else {
        refetchJobs();
      }
    } catch {
      setScanning(false);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }

  function mapsDirectionsUrl(
    destLat: number,
    destLng: number
  ): string {
    if (userLoc) {
      return `https://www.google.com/maps/dir/?api=1&origin=${userLoc.lat},${userLoc.lng}&destination=${destLat},${destLng}`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${destLat},${destLng}`;
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader title="Trip Planner" />
      <PageContent>
        <div>
          {/* Connection status */}
          <div className="flex flex-wrap gap-2 mb-6">
            {sfConnected === true ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                Salesforce connected
              </span>
            ) : sfConnected === false ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                Salesforce not connected
              </span>
            ) : (
              <span className="text-xs text-gray-400">Checking...</span>
            )}
          </div>

          {/* Search card */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 mb-6">
            <h2 className="text-lg font-semibold text-navy mb-4">
              Where are you traveling?
            </h2>
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[250px]">
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="e.g. Denver, CO or 123 Main St, Houston, TX"
                  className="w-full text-sm border border-gray-300 rounded-lg px-4 py-2.5 focus:border-navy focus:outline-none"
                />
              </div>
              <div className="w-32">
                <label className="block text-[10px] text-gray-500 uppercase font-semibold mb-1">
                  Radius
                </label>
                <select
                  value={radius}
                  onChange={(e) => setRadius(Number(e.target.value))}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2.5 focus:border-navy focus:outline-none"
                >
                  <option value={50}>50 miles</option>
                  <option value={100}>100 miles</option>
                  <option value={150}>150 miles</option>
                  <option value={200}>200 miles</option>
                  <option value={300}>300 miles</option>
                </select>
              </div>
              <button
                onClick={handleSearch}
                disabled={searching || !location.trim()}
                className="px-6 py-2.5 bg-brand-orange hover:bg-brand-orange-hover disabled:bg-gray-300 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {searching ? "Searching…" : "Search"}
              </button>
              <button
                onClick={handleScan}
                disabled={scanning}
                className="px-4 py-2.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {scanning ? "Scanning…" : "Scan Accounts"}
              </button>
            </div>

            {/* Cancel links — visible when a job is in flight */}
            {(searching || scanning) && (
              <div className="mt-2 flex items-center gap-4 text-xs text-ink-muted">
                {searching && (
                  <button
                    onClick={handleCancelSearch}
                    className="hover:text-danger underline underline-offset-2 transition-colors"
                  >
                    Cancel search
                  </button>
                )}
                {scanning && (
                  <button
                    onClick={handleCancelScan}
                    className="hover:text-danger underline underline-offset-2 transition-colors"
                  >
                    Cancel scan
                  </button>
                )}
              </div>
            )}

            {/* Scan progress */}
            {scanning && scanProgress && (
              <div className="mt-3 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  Scanning: {scanProgress.cached} of {scanProgress.total} accounts geocoded
                  ({scanProgress.remaining} remaining)
                </div>
                <div className="mt-1.5 w-full h-1.5 bg-blue-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{
                      width: `${Math.round((scanProgress.cached / scanProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {scanDone && scanProgress && !scanning && (
              <div className="mt-3 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                Scan complete: {scanProgress.cached} of {scanProgress.total} accounts geocoded.
                You can now search.
              </div>
            )}
          </div>

          {/* Error */}
          {searchError && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4 text-sm text-red-700">
              {searchError}
            </div>
          )}

          {/* Uncached warning */}
          {uncachedCount > 0 && results !== null && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4 text-sm text-amber-700">
              {uncachedCount} account{uncachedCount !== 1 ? "s" : ""} not
              geocoded yet — click <strong>Scan Accounts</strong> first to
              include them in search results.
            </div>
          )}

          {/* Results area */}
          {(results !== null || discovered !== null) && (
            <>
              {/* Tabs */}
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setActiveTab("existing")}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    activeTab === "existing"
                      ? "bg-navy text-white"
                      : "bg-white text-gray-600 border border-gray-200 hover:border-gray-300"
                  }`}
                >
                  Existing Accounts ({results?.length ?? 0})
                </button>
                <button
                  onClick={() => setActiveTab("discover")}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    activeTab === "discover"
                      ? "bg-navy text-white"
                      : "bg-white text-gray-600 border border-gray-200 hover:border-gray-300"
                  }`}
                >
                  Discover New{" "}
                  {discovering ? (
                    <span className="ml-1 inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : discovered ? (
                    `(${discovered.filter((c) => c.ownership !== "aggregator").length})`
                  ) : null}
                </button>
              </div>

              {/* ── Tab 1: Existing Accounts ─────────────────────────────── */}
              {activeTab === "existing" && (
                <>
                  {searching ? (
                    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                      <p className="text-gray-400 text-sm">
                        Searching nearby accounts…
                      </p>
                    </div>
                  ) : results && results.length > 0 ? (
                    <div className="space-y-2">
                      {userLoc && (
                        <p className="text-xs text-gray-500 mb-3">
                          {results.length} account
                          {results.length !== 1 ? "s" : ""} within {radius}{" "}
                          miles of{" "}
                          <span className="font-medium text-gray-700">
                            {userLoc.formattedAddress}
                          </span>
                        </p>
                      )}
                      {results.map((r) => (
                        <div
                          key={r.accountId}
                          className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex items-start justify-between gap-4"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <a
                                href={r.sfUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-base font-semibold text-navy hover:underline"
                              >
                                {r.accountName}
                              </a>
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                  r.addressSource === "billing"
                                    ? "text-green-700 bg-green-50 border-green-200"
                                    : "text-blue-700 bg-blue-50 border-blue-200"
                                }`}
                              >
                                {r.addressSource === "billing"
                                  ? "Billing"
                                  : "Google Places"}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 mb-1">
                              {r.address}
                            </p>
                            <div className="flex flex-wrap gap-x-4 text-xs text-gray-500">
                              <span>
                                Owner:{" "}
                                <span className="text-gray-700">
                                  {r.ownerName}
                                </span>
                              </span>
                              <span>
                                Last activity:{" "}
                                <span className="text-gray-700">
                                  {fmtDate(r.lastActivityDate)}
                                </span>
                              </span>
                              {r.website && (
                                <a
                                  href={
                                    r.website.startsWith("http")
                                      ? r.website
                                      : `https://${r.website}`
                                  }
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-gray-400 hover:text-navy"
                                >
                                  {r.website}
                                </a>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-lg font-bold text-navy">
                              {r.durationText ?? `~${r.distanceMiles} mi`}
                            </p>
                            <p className="text-xs text-gray-500">
                              {r.distanceMiles} miles
                            </p>
                            <a
                              href={mapsDirectionsUrl(r.lat, r.lng)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-blue-600 hover:underline mt-1 inline-block"
                            >
                              Directions ↗
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : results && results.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                      <p className="text-gray-400 text-sm">
                        No CDM accounts found within {radius} miles. Try a
                        larger radius?
                      </p>
                    </div>
                  ) : null}
                </>
              )}

              {/* ── Tab 2: Discover New Companies ────────────────────────── */}
              {activeTab === "discover" && (
                <>
                  {discovering ? (
                    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                      <p className="text-gray-500 text-sm mb-2">
                        Searching 9 CDM sub-verticals for software companies
                        near {location}…
                      </p>
                      <p className="text-xs text-gray-400">
                        This takes 1-3 minutes. Checking ownership status for
                        each company.
                      </p>
                      <div className="mt-4 w-48 mx-auto h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-brand-orange rounded-full animate-pulse w-2/3" />
                      </div>
                    </div>
                  ) : discoveryError ? (
                    <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">
                      {discoveryError}
                    </div>
                  ) : discovered && discovered.length > 0 ? (
                    <div>
                      {discoveryStats && (
                        <p className="text-xs text-gray-500 mb-3">
                          Found {discoveryStats.found} companies across{" "}
                          {discoveryStats.searched} verticals.{" "}
                          {discoveryStats.filteredByGeo > 0 && (
                            <span>
                              {discoveryStats.filteredByGeo} outside radius
                              (removed).{" "}
                            </span>
                          )}
                          {discoveryStats.deduped > 0 && (
                            <span>
                              {discoveryStats.deduped} already in Salesforce
                              (removed).{" "}
                            </span>
                          )}
                          Showing {discoveryStats.final} results.
                        </p>
                      )}
                      <div className="space-y-2">
                        {discovered.map((c, i) => (
                          <div
                            key={i}
                            className={`bg-white rounded-2xl border shadow-sm p-5 ${
                              c.ownership === "aggregator"
                                ? "border-red-200 opacity-50"
                                : "border-gray-200"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  {c.website ? (
                                    <a
                                      href={
                                        c.website.startsWith("http")
                                          ? c.website
                                          : `https://${c.website}`
                                      }
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className={`text-base font-semibold hover:underline ${
                                        c.ownership === "aggregator"
                                          ? "text-gray-400 line-through"
                                          : "text-navy"
                                      }`}
                                    >
                                      {c.name}
                                    </a>
                                  ) : (
                                    <span
                                      className={`text-base font-semibold ${
                                        c.ownership === "aggregator"
                                          ? "text-gray-400 line-through"
                                          : "text-navy"
                                      }`}
                                    >
                                      {c.name}
                                    </span>
                                  )}
                                  <span className="text-[10px] px-2 py-0.5 rounded-full border bg-navy text-white border-navy">
                                    {c.subVertical}
                                  </span>
                                  {c.employeesEstimate != null && (
                                    <span
                                      className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                        c.employeesEstimate >= 20 &&
                                        c.employeesEstimate <= 150
                                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                          : "bg-gray-100 text-gray-500 border-gray-200"
                                      }`}
                                    >
                                      ~{c.employeesEstimate} employees
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm text-gray-600 mb-1">
                                  {c.description}
                                </p>
                                <p className="text-xs text-gray-400 flex items-center gap-2 flex-wrap">
                                  <span>
                                    {[c.city, c.state].filter(Boolean).join(", ") ||
                                      "Location unknown"}
                                  </span>
                                  {c.distanceMiles != null && (
                                    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                      {c.distanceMiles} mi
                                      {c.durationText ? ` · ${c.durationText}` : ""}
                                    </span>
                                  )}
                                  {c.distanceMiles == null &&
                                    c.straightLineMiles != null && (
                                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                                        ~{c.straightLineMiles} mi
                                      </span>
                                    )}
                                </p>
                              </div>
                              <div className="shrink-0">
                                <span
                                  className={`text-xs px-2 py-1 rounded-full border ${
                                    c.ownership === "independent"
                                      ? "text-green-700 bg-green-50 border-green-200"
                                      : c.ownership === "pe_vc"
                                      ? "text-blue-700 bg-blue-50 border-blue-200"
                                      : "text-red-700 bg-red-50 border-red-200"
                                  }`}
                                >
                                  {c.ownership === "independent"
                                    ? "Independent"
                                    : c.ownership === "pe_vc"
                                    ? "PE/VC"
                                    : "Aggregator"}
                                </span>
                                {c.ownershipDetail && (
                                  <p className="text-[10px] text-gray-400 mt-1 max-w-[200px] text-right">
                                    {c.ownershipDetail}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : discovered && discovered.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                      <p className="text-gray-700 text-sm font-medium mb-2">
                        No new companies to show.
                      </p>
                      {discoveryStats ? (
                        <>
                          <p className="text-gray-500 text-xs mb-3">
                            AI searched {discoveryStats.searched} verticals and
                            returned <strong>{discoveryStats.found}</strong>{" "}
                            companies.
                            {discoveryStats.filteredByGeo > 0 && (
                              <>
                                {" "}
                                <strong>{discoveryStats.filteredByGeo}</strong>{" "}
                                were outside the {/* radius */}radius (or had
                                no city to verify).
                              </>
                            )}
                            {discoveryStats.deduped > 0 && (
                              <>
                                {" "}
                                <strong>{discoveryStats.deduped}</strong> were
                                already in Salesforce.
                              </>
                            )}
                          </p>
                          <p className="text-gray-400 text-xs">
                            {discoveryStats.found === 0
                              ? "The AI couldn't find any small software companies near this location for the CDM verticals. Try a larger radius or a different city."
                              : "All discovered candidates were filtered out before display. Try a larger radius."}
                          </p>
                        </>
                      ) : (
                        <p className="text-gray-400 text-xs">
                          Try a larger radius or different location.
                        </p>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      </PageContent>
    </>
  );
}
