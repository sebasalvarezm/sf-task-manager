"use client";

import { useEffect, useState } from "react";

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
  ownership: "independent" | "pe_vc" | "aggregator";
  ownershipDetail: string | null;
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

  // ── Search handler ─────────────────────────────────────────────────────

  async function handleSearch() {
    if (!location.trim()) return;

    setSearching(true);
    setSearchError(null);
    setResults(null);
    setDiscovered(null);
    setDiscoveryStats(null);
    setDiscoveryError(null);

    // Fire both searches: existing accounts (fast) + discovery (slow)
    const searchPromise = (async () => {
      try {
        const res = await fetch("/api/trip/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: location.trim(),
            radiusMiles: radius,
          }),
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          setSearchError(`Server error: ${text.slice(0, 300)}`);
          return;
        }
        if (!res.ok) {
          setSearchError(data.error || "Search failed");
          return;
        }
        setResults(data.results ?? []);
        setUserLoc(data.userLocation ?? null);
        setUncachedCount(data.geocodeStats?.uncached ?? 0);
      } catch (e: unknown) {
        setSearchError(
          e instanceof Error ? e.message : "Network error"
        );
      }
      setSearching(false);
    })();

    // Discovery runs in parallel (slower, ~1-3 min)
    setDiscovering(true);
    const discoverPromise = (async () => {
      try {
        const res = await fetch("/api/trip/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: location.trim(),
            radiusMiles: radius,
          }),
          signal: AbortSignal.timeout(300000), // 5 min timeout
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          setDiscoveryError(`Server error: ${text.slice(0, 300)}`);
          return;
        }
        if (!res.ok) {
          setDiscoveryError(data.error || "Discovery failed");
          return;
        }
        setDiscovered(data.companies ?? []);
        setDiscoveryStats(data.stats ?? null);
      } catch (e: unknown) {
        setDiscoveryError(
          e instanceof Error ? e.message : "Discovery error"
        );
      }
      setDiscovering(false);
    })();

    await Promise.all([searchPromise, discoverPromise]);
  }

  // ── Scan handler ───────────────────────────────────────────────────────

  async function handleScan() {
    setScanning(true);
    setScanDone(false);
    setScanProgress(null);

    // Loop: each call processes ~40 accounts, repeat until done
    let done = false;
    while (!done) {
      try {
        const res = await fetch("/api/trip/geocode-all", { method: "POST" });
        if (!res.ok) break;
        const data = await res.json();
        setScanProgress({
          total: data.total,
          cached: data.cached,
          remaining: data.remaining,
        });
        done = data.done;
      } catch {
        break;
      }
    }

    setScanDone(true);
    setScanning(false);
    setUncachedCount(0);
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
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-3">
          <img
            src="/valstone-logo.png"
            alt="Valstone"
            className="h-8 w-auto rounded"
          />
          <span className="text-sm text-gray-300">Trip Planner</span>
        </div>
        <a href="/" className="text-gray-300 hover:text-white text-sm">
          ← Back to Home
        </a>
      </header>

      <main className="flex-1 px-8 py-10">
        <div className="max-w-6xl mx-auto">
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
                                </div>
                                <p className="text-sm text-gray-600 mb-1">
                                  {c.description}
                                </p>
                                <p className="text-xs text-gray-400">
                                  {[c.city, c.state].filter(Boolean).join(", ") || "Location unknown"}
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
                      <p className="text-gray-400 text-sm">
                        No new companies found for this area. Try a larger
                        radius or different location.
                      </p>
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
