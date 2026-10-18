"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ConnectSalesforce from "../../components/ConnectSalesforce";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Badge } from "@/app/components/ui/Badge";
import { Alert } from "@/app/components/ui/Alert";
import { AlertCircle, AlertTriangle, Check, X } from "lucide-react";
import { useJobs, type Job, useJobResult } from "@/app/hooks/useJobs";

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
    <Suspense fallback={<div className="min-h-screen bg-surface" />}>
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
  // The enrichment payload is fetched on demand rather than riding along on
  // every poll of the job list. Re-fetches once when the job's status changes.
  const { job: activeJobDetail } = useJobResult(activeJob?.id, activeJob?.status);

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
    if (activeJob.status === "succeeded" && activeJobDetail?.result) {
      const resultItems =
        (activeJobDetail.result as { items?: JobResultItem[] }).items ?? [];
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
    // by the polling refresh once the job has succeeded. The payload arrives
    // separately via useJobResult, so it is part of the key too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, activeJob?.status, activeJobDetail?.id]);

  async function checkConnection() {
    try {
      const res = await fetch("/api/salesforce/status");
      if (res.ok) {
        const data = await res.json();
        setSfConnected(data.connected);
        if (data.connected) fetchPicklists();
      } else {
        // A failed status check means "can't tell": show the connect
        // prompt rather than "Checking connection…" forever.
        setSfConnected(false);
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
    if (!window.confirm("Disconnect Salesforce? This signs the whole app out of Salesforce until you reconnect.")) return;
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
        title="Account creator"
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
            <p className="text-sm text-ink-secondary">Loading…</p>
          </div>
        )}

        {sfConnected === false && (
          <div className="bg-white border border-line rounded-md p-6 text-center mb-6">
            <p className="text-ink font-medium mb-1">Salesforce is not connected.</p>
            <p className="text-ink-secondary text-sm mb-4">Connect Salesforce to create accounts.</p>
            <a
              href="/api/salesforce/connect"
              className="inline-flex items-center justify-center h-9 bg-white border border-line-strong hover:bg-surface-3 text-ink text-sm font-medium px-4 rounded-sm transition-colors"
            >
              Connect Salesforce
            </a>
          </div>
        )}

        {sfConnected === true && (
          <>
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-normal text-ink">Account creator</h2>
                <p className="text-sm text-ink-secondary mt-0.5">
                  Paste up to 5 company URLs to auto-fill and create Salesforce accounts
                </p>
              </div>
              {(activeJob || isReviewPhase) && (
                <button
                  onClick={handleReset}
                  className="text-sm text-ink underline decoration-1 underline-offset-2 hover:text-ink-secondary mt-1"
                >
                  Start new run
                </button>
              )}
            </div>

            {/* ── INPUT PHASE (no active job) ──────────────────────────── */}
            {!activeJob && (
              <div className="bg-white rounded-md border border-line p-5 mb-6">
                <label className="block text-sm text-ink-secondary mb-3">
                  Company website URLs
                </label>

                <div className="flex flex-col gap-2 mb-4">
                  {urlInputs.map((u, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <span className="text-xs text-ink-muted w-4 text-right shrink-0 tabular-nums">{i + 1}</span>
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
                        className="flex-1 h-10 border border-line-strong rounded-sm px-3 text-sm text-ink bg-white placeholder:text-ink-muted focus:outline-none focus:border-ink focus:ring-2 focus:ring-surface-4 disabled:bg-surface-3"
                        disabled={submitting}
                      />
                      {urlInputs.length > 1 && (
                        <button
                          onClick={() => handleRemoveUrl(i)}
                          className="text-ink-muted hover:text-ink px-1 rounded-sm"
                          title="Remove"
                        >
                          <X className="h-4 w-4" strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between">
                  {urlInputs.length < 5 ? (
                    <button
                      onClick={handleAddUrl}
                      className="text-sm text-ink underline decoration-1 underline-offset-2"
                    >
                      Add another URL
                    </button>
                  ) : (
                    <span className="text-xs text-ink-muted">Maximum 5 URLs</span>
                  )}

                  <Button
                    onClick={handleEnrichAll}
                    disabled={submitting || !canEnrichAll}
                    loading={submitting}
                  >
                    {submitting ? "Starting…" : urlInputs.filter((u) => u.trim()).length > 1 ? "Enrich all" : "Enrich"}
                  </Button>
                </div>

                {submitError && (
                  <Alert variant="danger" className="mt-4">
                    {submitError}
                  </Alert>
                )}

                <p className="text-xs text-ink-muted mt-4">
                  Takes about 30–60 seconds per URL. You can navigate away — the bell will light up when it's done.
                </p>
              </div>
            )}

            {/* ── JOB IN FLIGHT ─────────────────────────────────────────── */}
            {isJobInFlight && (
              <div className="bg-white rounded-md border border-line p-5 mb-6">
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-ink">
                      {activeJob?.status === "queued"
                        ? "Queued — waiting for a worker"
                        : activeJob?.progress?.step
                          ? `Running — ${activeJob.progress.step}`
                          : "Enriching accounts…"}
                    </p>
                    <p className="text-xs text-ink-secondary mt-1">
                      You can switch to another tool. The bell will light up when it's done.
                    </p>
                    {typeof activeJob?.progress?.pct === "number" &&
                      activeJob.progress.pct > 0 && (
                        <div className="mt-3 h-1.5 w-full bg-surface-4 rounded-sm overflow-hidden">
                          <div
                            className="h-full bg-info transition-all"
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
              <Alert variant="danger" title="This run failed" className="mb-6">
                <p>{activeJob?.error ?? "Unknown error"}</p>
                <button
                  onClick={handleReset}
                  className="mt-2 text-sm text-ink underline decoration-1 underline-offset-2 hover:text-ink-secondary"
                >
                  Start a new run
                </button>
              </Alert>
            )}

            {/* ── REVIEW PHASE (job succeeded, items hydrated) ─────────── */}
            {isReviewPhase && (
              <>
                {items.length > 1 && (
                  <div className="flex gap-1 mb-4 flex-wrap border border-line rounded-md p-1 w-fit bg-white">
                    {items.map((item, i) => {
                      const isActive = i === activeIndex;
                      const isCreated = item.createResult?.success;
                      const hasDuplicate = !!item.duplicate;
                      const hasError = !!item.enrichError;

                      const tabStyle = isActive
                        ? "bg-navy text-white"
                        : "text-ink-secondary hover:bg-surface-3";

                      return (
                        <button
                          key={i}
                          onClick={() => setActiveIndex(i)}
                          className={`rounded-sm px-3 py-1.5 text-sm transition-colors flex items-center gap-1.5 tabular-nums ${tabStyle}`}
                        >
                          {isCreated ? (
                            <Check className={`h-3.5 w-3.5 ${isActive ? "" : "text-ok"}`} strokeWidth={1.5} />
                          ) : hasDuplicate ? (
                            <AlertTriangle className={`h-3.5 w-3.5 ${isActive ? "" : "text-warn"}`} strokeWidth={1.5} />
                          ) : hasError ? (
                            <AlertCircle className={`h-3.5 w-3.5 ${isActive ? "" : "text-danger"}`} strokeWidth={1.5} />
                          ) : null}
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
                    <div className="bg-white rounded-md border border-line p-5 mb-4">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-base font-medium text-ink">
                          {items.length > 1 ? `Account ${i + 1}` : "Review and edit"}
                        </h3>
                        <div className="flex items-center gap-3">
                          {item.confidence && (
                            <Badge
                              variant={
                                item.confidence === "high"
                                  ? "ok"
                                  : item.confidence === "medium"
                                  ? "warn"
                                  : "danger"
                              }
                              size="md"
                            >
                              {item.confidence === "high"
                                ? "High confidence"
                                : item.confidence === "medium"
                                ? "Medium confidence"
                                : "Low confidence — please review"}
                            </Badge>
                          )}
                        </div>
                      </div>

                      {item.enrichError && (
                        <p className="mb-4 text-sm text-ink-secondary">
                          {item.enrichError} — fill in the fields below.
                        </p>
                      )}

                      {item.duplicate && (
                        <div className="mb-4 bg-white border border-line rounded-md p-3 flex items-start justify-between gap-3">
                          <div className="text-sm text-ink">
                            <span className="font-medium">Possible duplicate found in Salesforce:</span>{" "}
                            <span className="text-ink-secondary">{item.duplicate.accountName}</span>
                          </div>
                          <a
                            href={item.duplicate.accountUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-ink underline decoration-1 underline-offset-2 hover:text-ink-secondary whitespace-nowrap"
                          >
                            Open
                          </a>
                        </div>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                        <div>
                          <label className="block text-xs text-ink-secondary mb-1">Company name *</label>
                          <input
                            type="text"
                            value={item.form.companyName}
                            onChange={(e) => updateItemField(i, "companyName", e.target.value)}
                            className={FIELD}
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-ink-secondary mb-1">Website</label>
                          <input
                            type="text"
                            value={item.form.website}
                            readOnly
                            className="w-full h-10 border border-line rounded-sm px-3 text-sm bg-surface-3 text-ink-secondary"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-ink-secondary mb-1">Year established</label>
                          <input
                            type="text"
                            value={item.form.yearEstablished}
                            onChange={(e) => updateItemField(i, "yearEstablished", e.target.value)}
                            placeholder="e.g. 2005"
                            className={`${FIELD} tabular-nums`}
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-ink-secondary mb-1">Employees</label>
                          <input
                            type="number"
                            value={item.form.employees}
                            onChange={(e) => updateItemField(i, "employees", e.target.value)}
                            placeholder="e.g. 150"
                            className={`${FIELD} tabular-nums`}
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-ink-secondary mb-1">Industry</label>
                          <select
                            value={item.form.industry}
                            onChange={(e) => updateItemField(i, "industry", e.target.value)}
                            className={FIELD}
                          >
                            {industryOptions.map((opt) => (
                              <option key={opt} value={opt}>{opt || "— Select industry —"}</option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs text-ink-secondary mb-1">Country</label>
                          <input
                            type="text"
                            value={item.form.country}
                            onChange={(e) => updateItemField(i, "country", e.target.value)}
                            placeholder="e.g. United States"
                            className={FIELD}
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-ink-secondary mb-1">State / province</label>
                          <select
                            value={item.form.stateProvince}
                            onChange={(e) => updateItemField(i, "stateProvince", e.target.value)}
                            className={FIELD}
                          >
                            {stateOptions.map((opt) => (
                              <option key={opt} value={opt}>{opt || "— Select state / province —"}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="border-t border-line pt-4 mb-6">
                        <p className="text-xs text-ink-secondary mb-2">Auto-set defaults</p>
                        <div className="flex gap-6 text-sm text-ink-secondary">
                          <span>Group: <span className="text-ink">CDM</span></span>
                          <span>Stage: <span className="text-ink">Lead</span></span>
                          <span>Responded: <span className="text-ink">No</span></span>
                        </div>
                      </div>

                      {item.createResult && !item.createResult.success && (
                        <Alert variant="danger" className="mb-4">
                          {item.createResult.error}
                        </Alert>
                      )}

                      {item.createResult?.success && (
                        <div className="mb-4 bg-white border border-line rounded-md p-4 flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-ok">Account created</p>
                            <p className="text-xs text-ink-secondary mt-0.5">{item.form.companyName}</p>
                          </div>
                          {item.createResult.accountUrl && (
                            <a
                              href={item.createResult.accountUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-ink underline decoration-1 underline-offset-2 hover:text-ink-secondary"
                            >
                              Open in Salesforce
                            </a>
                          )}
                        </div>
                      )}

                      {!item.createResult?.success && (
                        <Button
                          onClick={() => handleCreateOne(i)}
                          disabled={item.creating || !canCreate}
                          loading={item.creating}
                          size="lg"
                          className="w-full"
                        >
                          {item.creating ? "Creating account…" : "Create account in Salesforce"}
                        </Button>
                      )}
                    </div>
                  );
                })()}

                {readyToCreateAll && (
                  <Button
                    variant="secondary"
                    onClick={handleCreateAll}
                    disabled={creatingAll}
                    loading={creatingAll}
                    size="lg"
                    className="w-full"
                  >
                    {creatingAll
                      ? "Creating all accounts…"
                      : `Create all ${items.filter((it) => !it.createResult?.success && it.form.companyName.trim()).length} accounts`}
                  </Button>
                )}
              </>
            )}

            {/* ── RECENT RUNS ──────────────────────────────────────────── */}
            {accountsJobs.length > 0 && (
              <div className="mt-8">
                <h2 className="text-sm text-ink-secondary mb-3">
                  Recent enrichment runs
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

const FIELD =
  "w-full h-10 border border-line-strong rounded-sm px-3 text-sm text-ink bg-white placeholder:text-ink-muted focus:outline-none focus:border-ink focus:ring-2 focus:ring-surface-4";

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
      className={`w-full text-left rounded-md border bg-white px-4 py-3 transition-colors hover:bg-surface-3 ${
        selected
          ? "border-ink"
          : "border-line hover:border-line-strong"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0 w-4">
          {status === "succeeded" && <Check className="h-4 w-4 text-ok" strokeWidth={1.5} />}
          {(status === "failed" || status === "cancelled") && (
            <X className="h-4 w-4 text-danger" strokeWidth={1.5} />
          )}
          {isInFlight && (
            <span className="text-xs text-ink-muted">…</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink truncate">
            {job.label ?? "Enrichment run"}
          </p>
          <p className="text-xs text-ink-secondary mt-0.5">
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
            <span className="text-xs text-ink-muted shrink-0 tabular-nums">{job.progress.pct}%</span>
          )}
      </div>
    </button>
  );
}
