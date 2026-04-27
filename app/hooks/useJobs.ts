"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type Job = {
  id: string;
  kind: "sourcing" | "prep" | "task_bulk" | "trip_geocode";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  label: string | null;
  progress: { step?: string; pct?: number } | null;
  result: Record<string, unknown> | null;
  result_route: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  seen_at: string | null;
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

export function useJobs(): UseJobsReturn {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [inProgressCount, setInProgressCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setJobs(data.jobs ?? []);
      setInProgressCount(data.inProgressCount ?? 0);
      setUnreadCount(data.unreadCount ?? 0);
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
      // Need to read latest in-progress count via state-bound closure.
      // Using a state setter callback to inspect latest count is gnarly here,
      // so keep the cadence on the simpler "if anything in progress, fast" rule.
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

  // Mirror the in-progress count into a ref so the polling loop can read it
  // without re-subscribing every render.
  const inProgressCountRef = useRef(0);
  useEffect(() => {
    inProgressCountRef.current = inProgressCount;
  }, [inProgressCount]);

  return {
    jobs,
    inProgressCount,
    unreadCount,
    loading,
    markAsSeen,
    refetch: fetchJobs,
  };
}
