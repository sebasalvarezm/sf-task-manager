"use client";

import { useEffect, useMemo, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search,
  CheckCircle2,
  Loader2,
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
  Info,
} from "lucide-react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Input } from "@/app/components/ui/Input";
import { Card } from "@/app/components/ui/Card";
import { Alert } from "@/app/components/ui/Alert";
import { Spinner } from "@/app/components/ui/Spinner";
import { Badge } from "@/app/components/ui/Badge";
import { useJobs, type Job } from "@/app/hooks/useJobs";

// ───────── Types matching SourcingResult from lib/jobs/sourcing-runner.ts ─────────

type PortfolioMatch = {
  matched: boolean;
  group: string | null;
  confidence?: number | null;
};

type WaybackStatus =
  | "ok"
  | "empty"
  | "timeout"
  | "http_error"
  | "network_error"
  | "fallback_used";

type SourcingResult = {
  url: string;
  products: string[];
  foundingYear: number | null;
  portfolioMatch: PortfolioMatch;
  archiveUrl: string | null;
  archiveYear: string | null;
  wbLabel: string;
  waybackStatus?: WaybackStatus | null;
  oldProducts: string[];
  discontinued: string | null;
  discontinuedNote: string | null;
  address: string | null;
  restaurants: { name: string; description: string }[];
  outreachParagraph: string | null;
  emailHook?: string | null;
  competitors: { name: string; differentiator: string }[];
  logs?: string[];
};

// ───────── Helpers ─────────

function domainFromUrl(url: string): string {
  try {
    const u = url.startsWith("http") ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function waybackEmptyMessage(
  status: WaybackStatus | null | undefined,
  archiveUrl: string | null,
  wbLabel: string,
): string {
  if (archiveUrl) {
    return "Snapshot was retrieved, but no distinct discontinued product could be identified from it.";
  }
  switch (status) {
    case "empty":
      return `Wayback Machine has no archived snapshots of this domain for ${wbLabel}.`;
    case "timeout":
      return "Wayback Machine timed out — try re-running. (This is a Wayback-side issue, not the company.)";
    case "http_error":
    case "network_error":
      return "Wayback Machine is currently unreachable. Retry later.";
    case "ok":
      return `Wayback returned snapshots for ${wbLabel}, but none passed validity checks (e.g. parked page or prior domain owner).`;
    default:
      return `No valid Wayback snapshot for ${wbLabel}.`;
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ───────── Page ─────────

export default function SourcingPage() {
  return (
    <Suspense fallback={<Spinner center />}>
      <SourcingPageContent />
    </Suspense>
  );
}

function SourcingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedJobId = searchParams.get("jobId");
  const isCachedView = searchParams.get("cached") === "1";
  const { jobs, refetch } = useJobs();

  const sourcingJobs = useMemo(
    () => jobs.filter((j) => j.kind === "sourcing"),
    [jobs],
  );

  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The cached job we navigated to may be older than the 20-job useJobs
  // window. Fetch it directly when not in the list.
  const [extraJob, setExtraJob] = useState<Job | null>(null);
  useEffect(() => {
    if (!selectedJobId) {
      setExtraJob(null);
      return;
    }
    if (sourcingJobs.some((j) => j.id === selectedJobId)) {
      setExtraJob(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${selectedJobId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.job) setExtraJob(data.job as Job);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedJobId, sourcingJobs]);

  async function startSourcingJob(rawUrl: string) {
    const cleaned = rawUrl.trim();
    const domain = domainFromUrl(cleaned);
    const res = await fetch("/api/jobs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "sourcing",
        input: { url: cleaned },
        label: `Sourcing: ${domain}`,
        resultRoute: `/sourcing?jobId={jobId}`,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to start job");
    return data.jobId as string;
  }

  async function handleSubmit(
    e: React.FormEvent,
    opts: { forceFresh?: boolean; urlOverride?: string } = {},
  ) {
    e.preventDefault();
    const rawUrl = opts.urlOverride ?? url;
    if (!rawUrl.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      // Cache pre-flight (skip if user explicitly asked for fresh)
      if (!opts.forceFresh) {
        try {
          const cacheRes = await fetch("/api/sourcing/find-cached", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: rawUrl.trim() }),
          });
          if (cacheRes.ok) {
            const cacheData = (await cacheRes.json()) as
              | { found: false }
              | { found: true; jobId: string; ageDays: number };
            if (cacheData.found) {
              setUrl("");
              router.push(`/sourcing?jobId=${cacheData.jobId}&cached=1`);
              return;
            }
          }
        } catch {
          // Cache lookup is best-effort. Fall through to a fresh run.
        }
      }

      // No cache hit (or forced fresh) — start a new job
      const jobId = await startSourcingJob(rawUrl);
      setUrl("");
      refetch();
      router.push(`/sourcing?jobId=${jobId}`);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Network error — try again",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const selectedJob =
    (selectedJobId && sourcingJobs.find((j) => j.id === selectedJobId)) ||
    (selectedJobId && extraJob?.id === selectedJobId ? extraJob : null) ||
    null;

  const cachedAgeDays =
    isCachedView && selectedJob
      ? Math.floor(
          (Date.now() - new Date(selectedJob.created_at).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : null;

  return (
    <>
      <PageHeader
        title="Sourcing"
        subtitle="Paste a company URL — the scrape runs in the background. Keep working in another tool while it does its thing."
      />
      <PageContent>
        {/* URL form */}
        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label className="text-sm font-medium text-ink">Company URL</label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="acme.com"
                disabled={submitting}
                leftIcon={<Search className="h-4 w-4" strokeWidth={1.75} />}
              />
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={submitting}
                disabled={!url.trim()}
                className="shrink-0"
              >
                {submitting ? "Starting…" : "Run"}
              </Button>
            </div>
            <p className="text-xs text-ink-muted">
              Takes about 30–90 seconds. You can navigate away — the bell will
              light up when it's done.
            </p>
            {submitError && (
              <Alert variant="danger">{submitError}</Alert>
            )}
          </form>
        </Card>

        {/* Cache banner — only when this view was loaded from a previous run */}
        {selectedJob && isCachedView && cachedAgeDays != null && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-info/20 bg-info-soft px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-info">
              <Info className="h-4 w-4 shrink-0" strokeWidth={2} />
              <span>
                Loaded from a previous run —{" "}
                {cachedAgeDays === 0
                  ? "earlier today"
                  : cachedAgeDays === 1
                    ? "1 day ago"
                    : `${cachedAgeDays} days ago`}
                .
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={submitting}
              onClick={(e) => {
                const cachedUrl =
                  typeof selectedJob.input?.url === "string"
                    ? (selectedJob.input.url as string)
                    : "";
                if (!cachedUrl) return;
                void handleSubmit(e as unknown as React.FormEvent, {
                  forceFresh: true,
                  urlOverride: cachedUrl,
                });
              }}
            >
              Run fresh
            </Button>
          </div>
        )}

        {/* Selected job result — rendered ABOVE the runs list so clicking a row
            doesn't push the result below the fold. */}
        {selectedJob && <JobResultPanel job={selectedJob} />}

        {/* Recent jobs list */}
        {sourcingJobs.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-muted mb-3">
              Recent Sourcing Runs
            </h2>
            <div className="space-y-2">
              {sourcingJobs.slice(0, 10).map((job) => (
                <SourcingJobRow
                  key={job.id}
                  job={job}
                  selected={job.id === selectedJobId}
                  onClick={() =>
                    router.push(
                      job.id === selectedJobId
                        ? "/sourcing"
                        : `/sourcing?jobId=${job.id}`,
                    )
                  }
                />
              ))}
            </div>
          </div>
        )}
      </PageContent>
    </>
  );
}

// ───────── Job row ─────────

function SourcingJobRow({
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
          ? "border-brand shadow-xs ring-1 ring-brand/20"
          : "border-line hover:border-line-strong"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          {status === "succeeded" && (
            <CheckCircle2 className="h-5 w-5 text-ok" strokeWidth={2} />
          )}
          {(status === "failed" || status === "cancelled") && (
            <AlertCircle className="h-5 w-5 text-danger" strokeWidth={2} />
          )}
          {isInFlight && (
            <Loader2 className="h-5 w-5 text-info animate-spin" strokeWidth={2} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink truncate">
            {job.label ?? "Sourcing run"}
          </p>
          <p className="text-xs text-ink-muted mt-0.5">
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
            <span className="text-xs text-ink-muted shrink-0">
              {job.progress.pct}%
            </span>
          )}
      </div>
    </button>
  );
}

// ───────── Result panel ─────────

function JobResultPanel({ job }: { job: Job }) {
  const status = job.status;

  if (status === "queued") {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 text-info animate-spin" strokeWidth={2} />
          <div>
            <p className="text-sm font-medium text-ink">Queued</p>
            <p className="text-xs text-ink-muted">
              Waiting for a worker to pick it up. This usually takes a few
              seconds.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (status === "running") {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 text-info animate-spin" strokeWidth={2} />
          <div className="flex-1">
            <p className="text-sm font-medium text-ink">
              Running{job.progress?.step ? ` · ${job.progress.step}` : ""}
            </p>
            <p className="text-xs text-ink-muted">
              Feel free to navigate to another tool — this keeps running in the
              background. The bell will light up when it's done.
            </p>
            {typeof job.progress?.pct === "number" && job.progress.pct > 0 && (
              <div className="mt-2 h-1.5 w-full bg-surface-3 rounded-full overflow-hidden">
                <div
                  className="h-full bg-info transition-all"
                  style={{ width: `${Math.min(100, job.progress.pct)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    );
  }

  if (status === "failed" || status === "cancelled") {
    return (
      <Alert variant="danger" title="This run failed">
        {job.error ?? "Unknown error"}
      </Alert>
    );
  }

  // succeeded
  const result = job.result as unknown as SourcingResult | null;
  if (!result) {
    return (
      <Alert variant="warn">No result data on this job — try running again.</Alert>
    );
  }

  return <SourcingResultDisplay result={result} />;
}

// ───────── Rich result display ─────────

function SourcingResultDisplay({ result }: { result: SourcingResult }) {
  const [copied, setCopied] = useState(false);
  const [copiedHook, setCopiedHook] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const copy = useCallback(async () => {
    if (!result.outreachParagraph) return;
    try {
      await navigator.clipboard.writeText(result.outreachParagraph);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, [result.outreachParagraph]);

  const copyHook = useCallback(async () => {
    if (!result.emailHook) return;
    try {
      await navigator.clipboard.writeText(result.emailHook);
      setCopiedHook(true);
      setTimeout(() => setCopiedHook(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, [result.emailHook]);

  const domain = domainFromUrl(result.url);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink">{domain}</h2>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {result.foundingYear && (
              <Badge variant="neutral">Founded {result.foundingYear}</Badge>
            )}
            {result.portfolioMatch.matched && result.portfolioMatch.group && (
              <Badge variant="brand">
                Portfolio: {result.portfolioMatch.group}
                {result.portfolioMatch.confidence != null
                  ? ` · ${result.portfolioMatch.confidence}%`
                  : ""}
              </Badge>
            )}
            {result.address && <Badge variant="neutral">{result.address}</Badge>}
          </div>
        </div>
      </div>

      {/* Email Opening Hook — full width, above the 3-col grid */}
      {result.emailHook && (
        <Card padded={false} className="p-5">
          <h3 className="text-xs font-semibold text-ink uppercase tracking-widest mb-3 pb-2 border-b border-line flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-brand" />
            Email Opening Hook
          </h3>
          <p className="text-sm text-ink leading-relaxed whitespace-pre-wrap">
            {result.emailHook}
          </p>
          <Button
            size="sm"
            variant={copiedHook ? "secondary" : "primary"}
            onClick={copyHook}
            leftIcon={
              copiedHook ? (
                <Check className="h-3.5 w-3.5" strokeWidth={2} />
              ) : (
                <Copy className="h-3.5 w-3.5" strokeWidth={2} />
              )
            }
            className="mt-3"
          >
            {copiedHook ? "Copied" : "Copy Hook"}
          </Button>
        </Card>
      )}

      {/* Top 3 cards: Products / Discontinued / Outreach */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card padded={false} className="p-5">
          <h3 className="text-xs font-semibold text-ink uppercase tracking-widest mb-3 pb-2 border-b border-line flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-brand" />
            Current Products
          </h3>
          {result.products.length === 0 ? (
            <p className="text-sm text-ink-muted">No named products found.</p>
          ) : (
            <ul className="text-sm text-ink space-y-1">
              {result.products.map((p, i) => (
                <li key={i} className="leading-snug">
                  {p}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card padded={false} className="p-5">
          <h3 className="text-xs font-semibold text-ink uppercase tracking-widest mb-3 pb-2 border-b border-line flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-brand" />
            Discontinued / Historical
          </h3>
          {result.discontinued ? (
            <div>
              <p className="text-sm font-semibold text-ink">
                {result.discontinued}
              </p>
              {result.discontinuedNote && (
                <p className="text-xs text-ink-muted mt-1">
                  {result.discontinuedNote}
                </p>
              )}
              {result.archiveUrl && (
                <a
                  href={result.archiveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mt-2 text-xs text-brand hover:text-brand-hover font-medium"
                >
                  View archived page
                  <ExternalLink className="h-3 w-3" strokeWidth={2} />
                </a>
              )}
              {result.waybackStatus === "fallback_used" && (
                <p className="text-xs text-ink-muted mt-2">
                  Snapshot retrieved via Wayback Availability fallback.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              {waybackEmptyMessage(result.waybackStatus, result.archiveUrl, result.wbLabel)}
            </p>
          )}
        </Card>

        <Card padded={false} className="p-5">
          <h3 className="text-xs font-semibold text-ink uppercase tracking-widest mb-3 pb-2 border-b border-line flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-brand" />
            Outreach Paragraph
          </h3>
          {result.outreachParagraph ? (
            <div>
              <p className="text-sm text-ink leading-relaxed whitespace-pre-wrap">
                {result.outreachParagraph}
              </p>
              <Button
                size="sm"
                variant={copied ? "secondary" : "primary"}
                onClick={copy}
                leftIcon={
                  copied ? (
                    <Check className="h-3.5 w-3.5" strokeWidth={2} />
                  ) : (
                    <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                  )
                }
                className="mt-3"
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              {result.portfolioMatch.matched
                ? "Could not generate."
                : "No portfolio group match."}
            </p>
          )}
        </Card>
      </div>

      {/* Restaurants */}
      {result.address && (
        <div>
          <h3 className="text-xs font-semibold text-ink uppercase tracking-widest mb-3 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-brand" />
            Nearby Restaurants
            <span className="text-ink-muted normal-case tracking-normal font-normal">
              — {result.address}
            </span>
          </h3>
          {result.restaurants.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {result.restaurants.map((r, i) => (
                <Card key={i} padded={false} className="p-5">
                  <p className="text-xs font-semibold text-brand uppercase tracking-widest mb-2">
                    Business Dinner
                  </p>
                  <p className="font-semibold text-ink mb-1">{r.name}</p>
                  <p className="text-sm text-ink-secondary">{r.description}</p>
                </Card>
              ))}
            </div>
          ) : (
            <Card padded={false} className="p-5">
              <p className="text-sm text-ink-muted">
                No restaurant suggestions available for this address. The
                location may be too remote for the AI to find well-known
                business-dinner spots, or the address itself may not be a
                clean street address.
              </p>
            </Card>
          )}
        </div>
      )}

      {/* Logs */}
      {result.logs && result.logs.length > 0 && (
        <div>
          <button
            onClick={() => setLogsOpen((v) => !v)}
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-ink-muted hover:text-ink transition-colors"
          >
            <span
              className={`inline-block transition-transform ${logsOpen ? "rotate-90" : ""}`}
            >
              ▶
            </span>
            Analysis Log ({result.logs.length} steps)
          </button>
          {logsOpen && (
            <div className="mt-3 bg-navy-dark rounded-lg border border-navy-light p-4 max-h-64 overflow-auto">
              {result.logs.map((log, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 mb-1.5 last:mb-0"
                >
                  <span className="text-brand text-xs mt-0.5 shrink-0 font-mono">
                    {">"}
                  </span>
                  <span className="text-ink-inverse-muted text-xs font-mono leading-relaxed">
                    {log}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
