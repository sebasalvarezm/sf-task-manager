"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import ConnectSalesforce from "../components/ConnectSalesforce";

// Salesforce standard Account Industry picklist values (exact)
const INDUSTRY_OPTIONS = [
  "",
  "Agriculture",
  "Apparel",
  "Banking",
  "Biotechnology",
  "Chemicals",
  "Communications",
  "Construction",
  "Consulting",
  "Education",
  "Electronics",
  "Energy",
  "Engineering",
  "Entertainment",
  "Environmental",
  "Finance",
  "Food & Beverage",
  "Government",
  "Healthcare",
  "Hospitality",
  "Insurance",
  "Machinery",
  "Manufacturing",
  "Media",
  "Not For Profit",
  "Recreation",
  "Retail",
  "Shipping",
  "Technology",
  "Telecommunications",
  "Transportation",
  "Utilities",
  "Other",
];

// US states + Canadian provinces (full names, matching Salesforce State/Country picklist)
const STATE_OPTIONS = [
  "",
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana",
  "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York",
  "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
  "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming",
  "Alberta", "British Columbia", "Manitoba", "New Brunswick",
  "Newfoundland and Labrador", "Northwest Territories", "Nova Scotia",
  "Nunavut", "Ontario", "Prince Edward Island", "Quebec",
  "Saskatchewan", "Yukon",
];

type FormData = {
  companyName: string;
  website: string;
  yearEstablished: string;
  employees: string;
  industry: string;
  country: string;
  stateProvince: string;
};

type CreateResult = {
  success: boolean;
  accountId?: string;
  accountUrl?: string;
  error?: string;
};

type DuplicateMatch = {
  accountId: string;
  accountName: string;
  accountUrl: string;
};

type AccountItem = {
  url: string;
  enriching: boolean;
  enrichError: string | null;
  form: FormData;
  confidence: "high" | "medium" | "low" | null;
  hasEnriched: boolean;
  createResult: CreateResult | null;
  creating: boolean;
  duplicate: DuplicateMatch | null;
  checkingDuplicate: boolean;
};

const emptyForm = (): FormData => ({
  companyName: "",
  website: "",
  yearEstablished: "",
  employees: "",
  industry: "",
  country: "",
  stateProvince: "",
});

const emptyItem = (url: string): AccountItem => ({
  url,
  enriching: true,
  enrichError: null,
  form: emptyForm(),
  confidence: null,
  hasEnriched: false,
  createResult: null,
  creating: false,
  duplicate: null,
  checkingDuplicate: true,
});

export default function AccountsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-navy" />}>
      <AccountsPageContent />
    </Suspense>
  );
}

function AccountsPageContent() {
  const router = useRouter();

  // ── Connection + picklist state ───────────────────────────────────────────
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [industryOptions, setIndustryOptions] = useState<string[]>(INDUSTRY_OPTIONS);
  const [stateOptions, setStateOptions] = useState<string[]>(STATE_OPTIONS);

  // ── Input phase state ─────────────────────────────────────────────────────
  const [urlInputs, setUrlInputs] = useState<string[]>([""]);

  // ── Review phase state ────────────────────────────────────────────────────
  const [items, setItems] = useState<AccountItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [creatingAll, setCreatingAll] = useState(false);

  const isReviewPhase = items.length > 0;

  // ── On mount: check connection + picklists ────────────────────────────────
  useEffect(() => {
    checkConnection();
  }, []);

  async function checkConnection() {
    try {
      const res = await fetch("/api/salesforce/status");
      if (res.ok) {
        const data = await res.json();
        setSfConnected(data.connected);
        if (data.connected) fetchPicklists();
      }
    } catch {
      setSfConnected(false);
    }
  }

  async function fetchPicklists() {
    try {
      const res = await fetch("/api/salesforce/picklists");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.industry) && data.industry.length > 0) {
        setIndustryOptions(["", ...data.industry]);
      }
      if (Array.isArray(data.stateProvince) && data.stateProvince.length > 0) {
        setStateOptions(["", ...data.stateProvince]);
      }
    } catch {
      // keep hardcoded fallback
    }
  }

  // ── URL input management ──────────────────────────────────────────────────
  function handleAddUrl() {
    if (urlInputs.length < 5) setUrlInputs((prev) => [...prev, ""]);
  }

  function handleRemoveUrl(i: number) {
    setUrlInputs((prev) => prev.filter((_, idx) => idx !== i));
  }

  function handleUrlChange(i: number, value: string) {
    setUrlInputs((prev) => prev.map((u, idx) => (idx === i ? value : u)));
  }

  // ── Enrich all URLs in parallel ───────────────────────────────────────────
  async function handleEnrichAll() {
    const validUrls = urlInputs.map((u) => u.trim()).filter(Boolean);
    if (validUrls.length === 0) return;

    // Initialise items array with loading state
    const initialItems = validUrls.map(emptyItem);
    setItems(initialItems);
    setActiveIndex(0);

    // Run enrichment + duplicate check in parallel for every URL
    await Promise.all(
      validUrls.map(async (url, i) => {
        // Run both requests simultaneously
        const [enrichRes, dupRes] = await Promise.allSettled([
          fetch("/api/enrich", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          }),
          fetch(`/api/salesforce/check-duplicate?url=${encodeURIComponent(url)}`),
        ]);

        setItems((prev) => {
          const next = [...prev];
          const item = { ...next[i] };

          // Process enrichment result
          if (enrichRes.status === "fulfilled" && enrichRes.value.ok) {
            enrichRes.value.json().then((data) => {
              setItems((p2) => {
                const n2 = [...p2];
                n2[i] = {
                  ...n2[i],
                  form: {
                    companyName: data.companyName ?? "",
                    website: data.website ?? url,
                    yearEstablished: data.yearEstablished ?? "",
                    employees: data.employees != null ? String(data.employees) : "",
                    industry: data.industry ?? "",
                    country: data.country ?? "",
                    stateProvince: data.stateProvince ?? "",
                  },
                  confidence: data.confidence ?? "medium",
                  hasEnriched: true,
                  enriching: false,
                };
                return n2;
              });
            });
          } else {
            item.enrichError = "Could not enrich this URL — you can fill in manually";
            item.hasEnriched = true;
            item.enriching = false;
            item.form = { ...emptyForm(), website: url };
          }

          // Process duplicate check result
          if (dupRes.status === "fulfilled" && dupRes.value.ok) {
            dupRes.value.json().then((data) => {
              setItems((p2) => {
                const n2 = [...p2];
                n2[i] = {
                  ...n2[i],
                  duplicate: data.duplicate ?? null,
                  checkingDuplicate: false,
                };
                return n2;
              });
            });
          } else {
            setItems((p2) => {
              const n2 = [...p2];
              n2[i] = { ...n2[i], checkingDuplicate: false };
              return n2;
            });
          }

          next[i] = item;
          return next;
        });
      })
    );
  }

  // ── Update a field in a specific item ─────────────────────────────────────
  function updateItemField(i: number, field: keyof FormData, value: string) {
    setItems((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], form: { ...next[i].form, [field]: value } };
      return next;
    });
  }

  // ── Create account for a single item ─────────────────────────────────────
  async function handleCreateOne(i: number) {
    const item = items[i];
    if (!item.form.companyName.trim() || !item.form.website.trim()) return;

    setItems((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], creating: true, createResult: null };
      return next;
    });

    try {
      const res = await fetch("/api/salesforce/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: item.form.companyName.trim(),
          website: item.form.website.trim(),
          yearEstablished: item.form.yearEstablished.trim() || undefined,
          employees: item.form.employees ? parseInt(item.form.employees) || undefined : undefined,
          industry: item.form.industry || undefined,
          country: item.form.country.trim() || undefined,
          stateProvince: item.form.stateProvince.trim() || undefined,
        }),
      });

      const data = await res.json();
      setItems((prev) => {
        const next = [...prev];
        next[i] = {
          ...next[i],
          creating: false,
          createResult: res.ok
            ? { success: true, accountId: data.accountId, accountUrl: data.accountUrl }
            : { success: false, error: data.error ?? "Failed to create account" },
        };
        return next;
      });
    } catch {
      setItems((prev) => {
        const next = [...prev];
        next[i] = {
          ...next[i],
          creating: false,
          createResult: { success: false, error: "Network error — please try again" },
        };
        return next;
      });
    }
  }

  // ── Create all ready items ────────────────────────────────────────────────
  async function handleCreateAll() {
    setCreatingAll(true);
    const pending = items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) =>
        !item.createResult?.success &&
        !item.creating &&
        item.form.companyName.trim() &&
        item.form.website.trim()
      );

    await Promise.all(pending.map(({ i }) => handleCreateOne(i)));
    setCreatingAll(false);
  }

  // ── Reset to input phase ──────────────────────────────────────────────────
  function handleReset() {
    setItems([]);
    setUrlInputs([""]);
    setActiveIndex(0);
  }

  // ── Disconnect / Logout ───────────────────────────────────────────────────
  async function handleSfDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setSfConnected(false);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const anyEnriching = urlInputs.some((_, i) => items[i]?.enriching);
  const canEnrichAll = urlInputs.some((u) => u.trim());
  const readyToCreateAll =
    items.length > 1 &&
    items.some(
      (item) =>
        !item.createResult?.success &&
        !item.creating &&
        item.form.companyName.trim() &&
        item.form.website.trim()
    );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-3 hover:opacity-90">
            <img src="/valstone-logo.png" alt="Valstone" className="h-8 w-auto rounded" />
            <span className="text-sm font-normal text-gray-300">Account Creator</span>
          </a>
        </div>
        <div className="flex items-center gap-4">
          <ConnectSalesforce connected={sfConnected === true} onDisconnect={handleSfDisconnect} />
          <button onClick={handleLogout} className="text-gray-300 hover:text-white text-sm">
            Sign out
          </button>
        </div>
      </header>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="flex-1 px-8 py-8 max-w-3xl mx-auto w-full">
        {sfConnected === null && (
          <div className="flex justify-center items-center py-24">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-orange" />
          </div>
        )}

        {sfConnected === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center mb-6">
            <p className="text-amber-800 font-medium mb-2">Salesforce is not connected.</p>
            <p className="text-amber-600 text-sm mb-4">Connect Salesforce to create accounts.</p>
            <a
              href="/api/salesforce/connect"
              className="inline-block bg-brand-orange hover:bg-brand-orange-hover text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
            >
              Connect Salesforce
            </a>
          </div>
        )}

        {sfConnected === true && (
          <>
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-navy">Account Creator</h2>
                <p className="text-sm text-gray-400 mt-0.5">
                  Paste up to 5 company URLs to auto-fill and create Salesforce accounts
                </p>
              </div>
              {isReviewPhase && (
                <button
                  onClick={handleReset}
                  className="text-sm text-gray-400 hover:text-gray-600 underline mt-1"
                >
                  Start over
                </button>
              )}
            </div>

            {/* ── INPUT PHASE ───────────────────────────────────────────── */}
            {!isReviewPhase && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-6">
                <label className="block text-sm font-medium text-navy mb-3">
                  Company Website URLs
                </label>

                <div className="flex flex-col gap-2 mb-4">
                  {urlInputs.map((u, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <span className="text-xs text-gray-400 w-4 text-right shrink-0">{i + 1}</span>
                      <input
                        type="text"
                        value={u}
                        onChange={(e) => handleUrlChange(i, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !anyEnriching) {
                            e.preventDefault();
                            handleEnrichAll();
                          }
                        }}
                        placeholder="https://example.com"
                        className="flex-1 border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                        disabled={anyEnriching}
                      />
                      {urlInputs.length > 1 && (
                        <button
                          onClick={() => handleRemoveUrl(i)}
                          className="text-gray-300 hover:text-red-400 text-lg leading-none px-1"
                          title="Remove"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between">
                  {urlInputs.length < 5 ? (
                    <button
                      onClick={handleAddUrl}
                      className="text-sm text-brand-orange hover:underline"
                    >
                      + Add another URL
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">Maximum 5 URLs</span>
                  )}

                  <button
                    onClick={handleEnrichAll}
                    disabled={anyEnriching || !canEnrichAll}
                    className="bg-brand-orange hover:bg-brand-orange-hover disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition-colors"
                  >
                    {anyEnriching ? "Enriching..." : urlInputs.filter((u) => u.trim()).length > 1 ? "Enrich All" : "Enrich"}
                  </button>
                </div>
              </div>
            )}

            {/* ── REVIEW PHASE ──────────────────────────────────────────── */}
            {isReviewPhase && (
              <>
                {/* Tabs */}
                {items.length > 1 && (
                  <div className="flex gap-2 mb-4 flex-wrap">
                    {items.map((item, i) => {
                      const isActive = i === activeIndex;
                      const isCreated = item.createResult?.success;
                      const hasDuplicate = !!item.duplicate;
                      const isEnriching = item.enriching;
                      const hasError = !!item.enrichError;

                      let tabStyle = isActive
                        ? "bg-navy text-white border-navy"
                        : "bg-white text-gray-600 border-gray-200 hover:border-gray-400";

                      if (!isActive && isCreated) tabStyle = "bg-green-50 text-green-700 border-green-300";
                      else if (!isActive && hasDuplicate) tabStyle = "bg-amber-50 text-amber-700 border-amber-300";
                      else if (!isActive && hasError) tabStyle = "bg-red-50 text-red-600 border-red-200";

                      return (
                        <button
                          key={i}
                          onClick={() => setActiveIndex(i)}
                          className={`border rounded-lg px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 ${tabStyle}`}
                        >
                          {isEnriching ? (
                            <span className="animate-spin inline-block w-3 h-3 border-b-2 border-current rounded-full" />
                          ) : isCreated ? (
                            <span>✓</span>
                          ) : hasDuplicate ? (
                            <span>⚠</span>
                          ) : null}
                          {i + 1}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Active item card */}
                {items[activeIndex] && (() => {
                  const item = items[activeIndex];
                  const i = activeIndex;
                  const canCreate = item.form.companyName.trim().length > 0 && item.form.website.trim().length > 0;

                  return (
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-4">
                      {/* Card header */}
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-semibold text-navy">
                          {items.length > 1 ? `Account ${i + 1}` : "Review & Edit"}
                        </h3>
                        <div className="flex items-center gap-3">
                          {item.confidence && !item.enriching && (
                            <span
                              className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                                item.confidence === "high"
                                  ? "bg-green-50 text-green-700 border border-green-200"
                                  : item.confidence === "medium"
                                  ? "bg-yellow-50 text-yellow-700 border border-yellow-200"
                                  : "bg-red-50 text-red-700 border border-red-200"
                              }`}
                            >
                              {item.confidence === "high"
                                ? "High confidence"
                                : item.confidence === "medium"
                                ? "Medium confidence"
                                : "Low confidence — please review"}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Loading state */}
                      {item.enriching && (
                        <div className="flex items-center gap-3 py-8 text-sm text-gray-500 justify-center">
                          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-brand-orange" />
                          Searching the web and extracting company data…
                        </div>
                      )}

                      {/* Enrich error */}
                      {item.enrichError && (
                        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                          {item.enrichError} — fill in the fields below.
                        </div>
                      )}

                      {/* Duplicate warning */}
                      {!item.enriching && item.duplicate && (
                        <div className="mb-4 bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-start justify-between gap-3">
                          <div className="text-sm text-amber-800">
                            <span className="font-medium">⚠ Possible duplicate found in Salesforce:</span>{" "}
                            <strong>{item.duplicate.accountName}</strong>
                          </div>
                          <a
                            href={item.duplicate.accountUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-amber-700 hover:text-amber-900 underline whitespace-nowrap"
                          >
                            Open →
                          </a>
                        </div>
                      )}

                      {/* Fields (hidden while enriching) */}
                      {!item.enriching && (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1">Company Name *</label>
                              <input
                                type="text"
                                value={item.form.companyName}
                                onChange={(e) => updateItemField(i, "companyName", e.target.value)}
                                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1">Website</label>
                              <input
                                type="text"
                                value={item.form.website}
                                readOnly
                                className="w-full border border-gray-100 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1">Year Established</label>
                              <input
                                type="text"
                                value={item.form.yearEstablished}
                                onChange={(e) => updateItemField(i, "yearEstablished", e.target.value)}
                                placeholder="e.g. 2005"
                                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1">Employees</label>
                              <input
                                type="number"
                                value={item.form.employees}
                                onChange={(e) => updateItemField(i, "employees", e.target.value)}
                                placeholder="e.g. 150"
                                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1">Industry</label>
                              <select
                                value={item.form.industry}
                                onChange={(e) => updateItemField(i, "industry", e.target.value)}
                                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange bg-white"
                              >
                                {industryOptions.map((opt) => (
                                  <option key={opt} value={opt}>{opt || "— Select industry —"}</option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1">Country</label>
                              <input
                                type="text"
                                value={item.form.country}
                                onChange={(e) => updateItemField(i, "country", e.target.value)}
                                placeholder="e.g. United States"
                                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-gray-500 mb-1">State / Province</label>
                              <select
                                value={item.form.stateProvince}
                                onChange={(e) => updateItemField(i, "stateProvince", e.target.value)}
                                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange bg-white"
                              >
                                {stateOptions.map((opt) => (
                                  <option key={opt} value={opt}>{opt || "— Select state / province —"}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="bg-gray-50 rounded-lg p-4 mb-6">
                            <p className="text-xs font-medium text-gray-400 mb-2 uppercase tracking-wide">Auto-set defaults</p>
                            <div className="flex gap-6 text-sm text-gray-600">
                              <span>Group: <strong>CDM</strong></span>
                              <span>Stage: <strong>Lead</strong></span>
                              <span>Responded: <strong>No</strong></span>
                            </div>
                          </div>

                          {/* Create error */}
                          {item.createResult && !item.createResult.success && (
                            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                              {item.createResult.error}
                            </div>
                          )}

                          {/* Success banner */}
                          {item.createResult?.success && (
                            <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-4 flex items-center justify-between">
                              <div>
                                <p className="text-sm font-semibold text-green-800">Account created!</p>
                                <p className="text-xs text-green-700 mt-0.5">{item.form.companyName}</p>
                              </div>
                              {item.createResult.accountUrl && (
                                <a
                                  href={item.createResult.accountUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-green-700 hover:text-green-900 underline"
                                >
                                  Open in Salesforce →
                                </a>
                              )}
                            </div>
                          )}

                          {/* Per-account create button */}
                          {!item.createResult?.success && (
                            <button
                              onClick={() => handleCreateOne(i)}
                              disabled={item.creating || !canCreate}
                              className="w-full bg-brand-orange hover:bg-brand-orange-hover disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm"
                            >
                              {item.creating ? (
                                <span className="flex items-center justify-center gap-2">
                                  <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                                  Creating account...
                                </span>
                              ) : (
                                "Create Account in Salesforce"
                              )}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Create All button — only when multiple items are pending */}
                {readyToCreateAll && (
                  <button
                    onClick={handleCreateAll}
                    disabled={creatingAll}
                    className="w-full border-2 border-brand-orange text-brand-orange hover:bg-brand-orange hover:text-white disabled:opacity-50 font-semibold py-3 rounded-lg transition-colors text-sm"
                  >
                    {creatingAll ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                        Creating all accounts...
                      </span>
                    ) : (
                      `Create All ${items.filter((it) => !it.createResult?.success && it.form.companyName.trim()).length} Accounts`
                    )}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
