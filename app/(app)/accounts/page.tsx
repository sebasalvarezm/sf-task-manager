"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ConnectSalesforce from "../../components/ConnectSalesforce";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { useJobs, type Job } from "@/app/hooks/useJobs";

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
  enrichError: string | null;
  hasEnriched: boolean;
  confidence: "high" | "medium" | "low" | null;
  form: FormData;
  duplicate: DuplicateMatch | null;
  creating: boolean;
  createResult: CreateResult | null;
};

type JobResultItem = {
  url: string;
  enrichError: string | null;
  hasEnriched: boolean;
  confidence: "high" | "medium" | "low" | null;
  form: FormData;
  duplicate: DuplicateMatch | null;
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export default function AccountsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-navy" />}>
      <AccountsPageContent />
    </Suspense>
  );
}

function AccountsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobId = searchParams.get("jobId");
  const { jobs, refetch } = useJobs();

  const accountsJobs = useMemo(
    () => jobs.filter((j) => j.kind === "accounts_enrich"),
    [jobs],
  );
  const activeJob = jobId ? accountsJobs.find((j) => j.id === jobId) : null;

  // ── Connection + picklist state ───────────────────────────────────────────
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [industryOptions, setIndustryOptions] = useState<string[]>(INDUSTRY_OPTIONS);
  const [stateOptions, setStateOptions] = useState<string[]>(STATE_OPTIONS);

  // ── Input phase state ─────────────────────────────────────────────────────
  const [urlInputs, setUrlInputs] = useState<string[]>([""]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Review phase state (hydrated from job.result) ────────────────────────
  const [items, setItems] = useState<AccountItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [creatingAll, setCreatingAll] = useState(false);

  // ── On mount: check connection + picklists ────────────────────────────────
  useEffect(() => {
    checkConnection();
  }, []);

  // ── Hydrate items from the active job's result ───────────────────────────
  useEffect(() => {
    if (!activeJob) {
      setItems([]);
      setActiveIndex(0);
      return;
    }
    if (activeJob.status === "succeeded" && activeJob.result) {
      const resultItems =
        (activeJob.result as { items?: JobResultItem[] }).items ?? [];
      setItems(
        resultItems.map((it) => ({
          ...it,
          creating: false,
          createResult: null,
        })),
      );
      setActiveIndex(0);
    } else {
      // queued / running / failed → no items to show yet
      setItems([]);
    }
    // We intentionally key on id+status so user edits/creates aren't clobbered
    // by the polling refresh once the job has succeeded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, activeJob?.status]);

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

  // ── Start a background enrichment job ─────────────────────────────────────
  async function handleEnrichAll() {
    const validUrls = urlInputs.map((u) => u.trim()).filter(Boolean);
    if (validUrls.length === 0 || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const label =
        validUrls.length === 1
          ? `Enrich: ${validUrls[0]}`
          : `Enrich ${validUrls.length} accounts`;
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "accounts_enrich",
          input: { urls: validUrls },
          label,
          resultRoute: `/accounts?jobId={jobId}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error ?? "Failed to start enrichment");
      } else if (data.jobId) {
        refetch();
        router.push(`/accounts?jobId=${data.jobId}`);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
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
    setSubmitError(null);
    router.push("/accounts");
  }

  // ── Disconnect / Logout ───────────────────────────────────────────────────
  async function handleSfDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setSfConnected(false);
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const canEnrichAll = urlInputs.some((u) => u.trim());
  const isJobInFlight =
    activeJob?.status === "queued" || activeJob?.status === "running";
  const isJobFailed =
    activeJob?.status === "failed" || activeJob?.status === "cancelled";
  const isReviewPhase = items.length > 0 && activeJob?.status === "succeeded";
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
    <>
      <PageHeader
        title="Account Creator"
        subtitle="Paste a company URL — the enrichment runs in the background. Keep working in another tool while it does its thing."
        actions={
          <ConnectSalesforce
            connected={sfConnected === true}
            onDisconnect={handleSfDisconnect}
          />
        }
      />
      <PageContent>
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
              {(activeJob || isReviewPhase) && (
                <button
                  onClick={handleReset}
                  className="text-sm text-gray-400 hover:text-gray-600 underline mt-1"
                >
                  Start new run
                </button>
              )}
            </div>

            {/* ── INPUT PHASE (no active job) ──────────────────────────── */}
            {!activeJob && (
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
                          if (e.key === "Enter" && !submitting) {
                            e.preventDefault();
                            handleEnrichAll();
                          }
                        }}
                        placeholder="https://example.com"
                        className="flex-1 border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                        disabled={submitting}
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
                    disabled={submitting || !canEnrichAll}
                    className="bg-brand-orange hover:bg-brand-orange-hover disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition-colors"
                  >
                    {submitting ? "Starting…" : urlInputs.filter((u) => u.trim()).length > 1 ? "Enrich All" : "Enrich"}
                  </button>
                </div>

                {submitError && (
                  <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                    {submitError}
                  </div>
                )}

                <p className="text-xs text-gray-400 mt-4">
                  Takes about 30–60 seconds per URL. You can navigate away — the bell will light up when it's done.
                </p>
              </div>
            )}

            {/* ── JOB IN FLIGHT ─────────────────────────────────────────── */}
            {isJobInFlight && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-6">
                <div className="flex items-start gap-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-orange shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-navy">
                      {activeJob?.status === "queued"
                        ? "Queued — waiting for a worker"
                        : activeJob?.progress?.step
                          ? `Running — ${activeJob.progress.step}`
                          : "Enriching accounts…"}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      You can switch to another tool. The bell will light up when it's done.
                    </p>
                    {typeof activeJob?.progress?.pct === "number" &&
                      activeJob.progress.pct > 0 && (
                        <div className="mt-3 h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-brand-orange transition-all"
                            style={{ width: `${Math.min(100, activeJob.progress.pct)}%` }}
                          />
                        </div>
                      )}
                  </div>
                </div>
              </div>
            )}

            {/* ── JOB FAILED ────────────────────────────────────────────── */}
            {isJobFailed && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-6 mb-6">
                <p className="text-sm font-semibold text-red-800 mb-1">
                  This run failed
                </p>
                <p className="text-sm text-red-700">
                  {activeJob?.error ?? "Unknown error"}
                </p>
                <button
                  onClick={handleReset}
                  className="mt-3 text-sm text-red-700 hover:text-red-900 underline"
                >
                  Start a new run
                </button>
              </div>
            )}

            {/* ── REVIEW PHASE (job succeeded, items hydrated) ─────────── */}
            {isReviewPhase && (
              <>
                {items.length > 1 && (
                  <div className="flex gap-2 mb-4 flex-wrap">
                    {items.map((item, i) => {
                      const isActive = i === activeIndex;
                      const isCreated = item.createResult?.success;
                      const hasDuplicate = !!item.duplicate;
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
                          {isCreated ? <span>✓</span> : hasDuplicate ? <span>⚠</span> : null}
                          {i + 1}
                        </button>
                      );
                    })}
                  </div>
                )}

                {items[activeIndex] && (() => {
                  const item = items[activeIndex];
                  const i = activeIndex;
                  const canCreate = item.form.companyName.trim().length > 0 && item.form.website.trim().length > 0;

                  return (
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-4">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-semibold text-navy">
                          {items.length > 1 ? `Account ${i + 1}` : "Review & Edit"}
                        </h3>
                        <div className="flex items-center gap-3">
                          {item.confidence && (
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

                      {item.enrichError && (
                        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                          {item.enrichError} — fill in the fields below.
                        </div>
                      )}

                      {item.duplicate && (
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

                      {item.createResult && !item.createResult.success && (
                        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                          {item.createResult.error}
                        </div>
                      )}

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
                    </div>
                  );
                })()}

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

            {/* ── RECENT RUNS ──────────────────────────────────────────── */}
            {accountsJobs.length > 0 && (
              <div className="mt-8">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">
                  Recent Enrichment Runs
                </h2>
                <div className="space-y-2">
                  {accountsJobs.slice(0, 10).map((job) => (
                    <RecentRunRow
                      key={job.id}
                      job={job}
                      selected={job.id === jobId}
                      onClick={() =>
                        router.push(
                          job.id === jobId
                            ? "/accounts"
                            : `/accounts?jobId=${job.id}`,
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </PageContent>
    </>
  );
}

function RecentRunRow({
  job,
  selected,
  onClick,
}: {
  job: Job;
  selected: boolean;
  onClick: () => void;
}) {
  const status = job.status;
  const isInFlight = status === "queued" || status === "running";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-lg border bg-white px-4 py-3 transition-all hover:shadow-sm ${
        selected
          ? "border-brand-orange shadow-xs ring-1 ring-brand-orange/20"
          : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          {status === "succeeded" && <span className="text-green-600 text-base">✓</span>}
          {(status === "failed" || status === "cancelled") && (
            <span className="text-red-600 text-base">✕</span>
          )}
          {isInFlight && (
            <span className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-brand-orange" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-navy truncate">
            {job.label ?? "Enrichment run"}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {status === "queued" && "Queued"}
            {status === "running" &&
              (job.progress?.step ? `Running · ${job.progress.step}` : "Running")}
            {status === "succeeded" &&
              `Done · ${relativeTime(job.completed_at ?? job.created_at)}`}
            {status === "failed" && `Failed · ${job.error ?? "Unknown error"}`}
            {status === "cancelled" && "Cancelled"}
          </p>
        </div>
        {isInFlight &&
          typeof job.progress?.pct === "number" &&
          job.progress.pct > 0 && (
            <span className="text-xs text-gray-400 shrink-0">{job.progress.pct}%</span>
          )}
      </div>
    </button>
  );
}
