"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";

export type JobKind =
  | "sourcing"
  | "sourcing_bulk"
  | "prep"
  | "task_bulk"
  | "trip_geocode"
  | "trip_search"
  | "calls_log"
  | "accounts_enrich";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * A job as it appears in the polled list.
 *
 * Deliberately carries NO `result` and NO `input`. This list is re-fetched
 * every few seconds, and including the research payload meant every poll
 * shipped ~421 KB where ~7 KB is used — enough to burn a month of Vercel and
 * Supabase transfer on its own. To read one job's payload, use
 * `useJobResult(id, status)`, which fetches it once.
 */
export type Job = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  label: string | null;
  progress: { step?: string; pct?: number } | null;
  result_route: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  seen_at: string | null;
};

/** One job including its payload, from `GET /api/jobs/[id]`. */
export type JobDetail = Job & {
  input?: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
};

export type UseJobsReturn = {
  jobs: Job[];
  inProgressCount: number;
  unreadCount: number;
  loading: boolean;
  markAsSeen: () => Promise<void>;
  refetch: () => Promise<void>;
};

const POLL_VISIBLE_ACTIVE = 3000;
const POLL_VISIBLE_IDLE = 15000;
const POLL_HIDDEN = 60000;

/**
 * The polling loop. Private on purpose — call it once, via `JobsProvider`.
 *
 * Every call site used to run its own copy of this, so six pages polled the
 * same endpoint twice concurrently. It now lives behind a context.
 */
function useJobsPolling(): UseJobsReturn {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [inProgressCount, setInProgressCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const inProgressCountRef = useRef(0);

  const fetchJobs = useCallback(async () => {
    try {
      // "no-cache" (not "no-store"): the browser still revalidates on every
      // poll, but it sends If-None-Match and reuses its cached copy when the
      // server answers 304. Nothing changed means no body over the wire.
      const res = await fetch("/api/jobs", { cache: "no-cache" });
      if (!res.ok) return;
      const data = await res.json();
      setJobs(data.jobs ?? []);
      setInProgressCount(data.inProgressCount ?? 0);
      setUnreadCount(data.unreadCount ?? 0);
      inProgressCountRef.current = data.inProgressCount ?? 0;
    } catch {
      // network blip — keep prior state
    } finally {
      setLoading(false);
    }
  }, []);

  const markAsSeen = useCallback(async () => {
    try {
      await fetch("/api/jobs/seen", { method: "POST" });
    } catch {
      // ignore — we'll re-poll soon
    }
    fetchJobs();
  }, [fetchJobs]);

  // Adaptive polling. Visible + active: 3s. Visible idle: 15s. Hidden: 60s.
  useEffect(() => {
    stoppedRef.current = false;

    const tick = async () => {
      if (stoppedRef.current) return;
      await fetchJobs();
      if (stoppedRef.current) return;
      const visible =
        typeof document === "undefined" || document.visibilityState === "visible";
      const interval = !visible
        ? POLL_HIDDEN
        : inProgressCountRef.current > 0
          ? POLL_VISIBLE_ACTIVE
          : POLL_VISIBLE_IDLE;
      timerRef.current = setTimeout(tick, interval);
    };

    tick();

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (timerRef.current) clearTimeout(timerRef.current);
      tick();
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      stoppedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [fetchJobs]);

  return {
    jobs,
    inProgressCount,
    unreadCount,
    loading,
    markAsSeen,
    refetch: fetchJobs,
  };
}

const JobsContext = createContext<UseJobsReturn | null>(null);

/** Mount once, in the app shell. Owns the single poll of `/api/jobs`. */
export function JobsProvider({ children }: { children: ReactNode }) {
  const value = useJobsPolling();
  return createElement(JobsContext.Provider, { value }, children);
}

/**
 * Read the shared job list. Safe to call from as many components as you like —
 * they all share one polling loop and one copy of the data.
 */
export function useJobs(): UseJobsReturn {
  const ctx = useContext(JobsContext);
  if (!ctx) {
    throw new Error("useJobs() requires <JobsProvider> above it in the tree");
  }
  return ctx;
}

/**
 * Fetch one job's full row, payload included.
 *
 * Not a hook — for the several pages whose "job finished, load its output"
 * effects already guard against running twice per job id. Those effects used to
 * read `job.result` straight off the polled list, which is why the list was
 * carrying every payload on every tick.
 *
 * Returns null on any failure; callers treat that as "no result yet".
 */
export async function fetchJobDetail(jobId: string): Promise<JobDetail | null> {
  try {
    const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-cache" });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.job ?? null) as JobDetail | null;
  } catch {
    return null;
  }
}

/** Just the payload of one job, or `{}` when it cannot be read. */
export async function fetchJobResult(
  jobId: string,
): Promise<Record<string, unknown>> {
  const job = await fetchJobDetail(jobId);
  return job?.result ?? {};
}

/**
 * Load one job's full payload, including `result`.
 *
 * Fetched once per job, then again only when the job's status changes — which
 * the cheap list poll tells us. So a running job's payload is fetched exactly
 * once, when it finishes, instead of on every poll tick.
 *
 * `status` may be undefined when the job is not in the polled window (an old
 * run opened by `?jobId=`); the payload is still fetched once.
 */
export function useJobResult(
  jobId: string | null | undefined,
  status?: JobStatus,
): { job: JobDetail | null; loading: boolean } {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchJobDetail(jobId)
      .then((detail) => {
        if (!cancelled) setJob(detail);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `status` is a dependency so a job that finishes re-fetches once. It must
    // NOT depend on the jobs array, whose identity changes on every poll.
  }, [jobId, status]);

  return { job, loading };
}
