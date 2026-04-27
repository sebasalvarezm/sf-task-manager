"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Bell,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Inbox,
} from "lucide-react";
import { useJobs, type Job } from "@/app/hooks/useJobs";

const KIND_LABEL: Record<Job["kind"], string> = {
  sourcing: "Sourcing",
  prep: "Call prep",
  task_bulk: "Task actions",
  trip_geocode: "Trip geocode",
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) {
    const m = Math.round(ms / 60_000);
    return `${m}m ago`;
  }
  if (ms < 86_400_000) {
    const h = Math.round(ms / 3_600_000);
    return `${h}h ago`;
  }
  const d = Math.round(ms / 86_400_000);
  return `${d}d ago`;
}

function StatusIcon({ status }: { status: Job["status"] }) {
  if (status === "succeeded") {
    return <CheckCircle2 className="h-4 w-4 text-ok" strokeWidth={2} />;
  }
  if (status === "failed" || status === "cancelled") {
    return <AlertCircle className="h-4 w-4 text-danger" strokeWidth={2} />;
  }
  // queued or running
  return <Loader2 className="h-4 w-4 text-info animate-spin" strokeWidth={2} />;
}

function statusText(job: Job): string {
  if (job.status === "queued") return "Queued";
  if (job.status === "running")
    return job.progress?.step ? `Running · ${job.progress.step}` : "Running";
  if (job.status === "succeeded")
    return job.completed_at ? `Done · ${relativeTime(job.completed_at)}` : "Done";
  if (job.status === "failed")
    return job.error ? `Failed · ${job.error}` : "Failed";
  return job.status;
}

export function NotificationBell() {
  const { jobs, unreadCount, inProgressCount, markAsSeen } = useJobs();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // When the user opens the panel, mark unread items as seen after a short
  // delay so they have time to glance at what's new.
  useEffect(() => {
    if (!open || unreadCount === 0) return;
    const t = setTimeout(() => {
      markAsSeen();
    }, 1500);
    return () => clearTimeout(t);
  }, [open, unreadCount, markAsSeen]);

  const showDot = unreadCount > 0;
  const showSpinnerDot = !showDot && inProgressCount > 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-1.5 text-ink-inverse-muted hover:text-white hover:bg-navy-dark transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        aria-label={
          showDot
            ? `${unreadCount} new notification${unreadCount === 1 ? "" : "s"}`
            : "Notifications"
        }
        aria-expanded={open}
      >
        <Bell className="h-4 w-4" strokeWidth={1.75} />
        {showDot && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-brand ring-2 ring-navy animate-pulse" />
        )}
        {showSpinnerDot && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-info ring-2 ring-navy" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 max-h-[480px] flex flex-col rounded-lg border border-line bg-surface-2 shadow-md z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Notifications</h3>
            {(inProgressCount > 0 || unreadCount > 0) && (
              <span className="text-xs text-ink-muted">
                {inProgressCount > 0 && (
                  <span>{inProgressCount} in progress</span>
                )}
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-12 px-6">
                <Inbox className="h-8 w-8 text-ink-muted mb-3" strokeWidth={1.5} />
                <p className="text-sm text-ink-muted">
                  No background jobs yet.
                </p>
                <p className="text-xs text-ink-muted mt-1">
                  Long-running tasks will appear here so you can keep working.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {jobs.map((job) => {
                  const isLinkable =
                    job.status === "succeeded" && job.result_route;
                  const Inner = (
                    <div className="flex items-start gap-3 px-4 py-3 hover:bg-surface-3 transition-colors">
                      <div className="mt-0.5 shrink-0">
                        <StatusIcon status={job.status} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink truncate">
                          {job.label ?? KIND_LABEL[job.kind]}
                        </p>
                        <p className="text-xs text-ink-muted mt-0.5 line-clamp-2">
                          {statusText(job)}
                        </p>
                      </div>
                      {!job.seen_at &&
                        (job.status === "succeeded" ||
                          job.status === "failed") && (
                          <span
                            className="mt-1.5 h-1.5 w-1.5 rounded-full bg-brand shrink-0"
                            aria-label="Unread"
                          />
                        )}
                    </div>
                  );
                  return (
                    <li key={job.id}>
                      {isLinkable ? (
                        <Link
                          href={job.result_route!}
                          onClick={() => setOpen(false)}
                          className="block"
                        >
                          {Inner}
                        </Link>
                      ) : (
                        Inner
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
