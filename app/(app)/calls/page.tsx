"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import WeekSelector, {
  WeekRange,
  generateWeeks,
  currentWeekIndex,
  getCompletedWeeks,
  markWeekCompleted,
} from "../../components/WeekSelector";
import CallLoggerTable, {
  MeetingRow,
  CallEntry,
  ManualMatch,
} from "../../components/CallLoggerTable";
import ConnectSalesforce from "../../components/ConnectSalesforce";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { useJobs } from "@/app/hooks/useJobs";
import { useRef } from "react";

type SubmitResult = {
  successCount: number;
  failCount: number;
  results: Array<{
    eventId?: string;
    accountName: string;
    callType: string;
    success: boolean;
    error?: string;
    followUpCreated: boolean;
    noteCreated: boolean;
  }>;
};

export default function CallsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-navy" />}>
      <CallsPageContent />
    </Suspense>
  );
}

function CallsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── State ───────────────────────────────────────────────────────────────────
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [msConnected, setMsConnected] = useState<boolean | null>(null);

  const [selectedWeek, setSelectedWeek] = useState<WeekRange | null>(
    () => generateWeeks()[currentWeekIndex()] // default to current week
  );
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [entries, setEntries] = useState<Map<string, CallEntry>>(new Map());

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [manualMatches, setManualMatches] = useState<Map<string, ManualMatch>>(new Map());

  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  const [completedWeeks, setCompletedWeeks] = useState<Set<string>>(
    () => getCompletedWeeks()
  );

  // ── On mount: check connections + handle OAuth redirect ─────────────────────
  useEffect(() => {
    const msOk = searchParams.get("ms_connected");
    const msErr = searchParams.get("ms_error");
    if (msOk || msErr) {
      router.replace("/calls");
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

  // ── Auto-mark week as completed when all meetings are handled ─────────────
  useEffect(() => {
    if (
      hasAnalyzed &&
      meetings.length > 0 &&
      selectedWeek &&
      meetings.every((m) => dismissedIds.has(m.eventId))
    ) {
      const key = `${selectedWeek.start}|${selectedWeek.end}`;
      if (!completedWeeks.has(key)) {
        markWeekCompleted(selectedWeek.start, selectedWeek.end);
        setCompletedWeeks(getCompletedWeeks());
      }
    }
  }, [meetings, dismissedIds, hasAnalyzed, selectedWeek, completedWeeks]);

  // ── Analyze week — fetch calendar + match to Salesforce ────────────────────
  async function handleAnalyze() {
    if (!selectedWeek) return;

    setAnalyzing(true);
    setAnalyzeError(null);
    setMeetings([]);
    setEntries(new Map());
    setDismissedIds(new Set());
    setManualMatches(new Map());
    setSubmitResult(null);
    setHasAnalyzed(false);

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
      setMeetings(data.meetings ?? []);
      setHasAnalyzed(true);
    } catch (err) {
      setAnalyzeError(
        err instanceof Error ? err.message : "Unexpected error"
      );
    } finally {
      setAnalyzing(false);
    }
  }

  // ── Dismiss management ─────────────────────────────────────────────────────
  function handleDismiss(eventId: string) {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(eventId);
      return next;
    });
  }

  // ── Entry management ───────────────────────────────────────────────────────
  function handleEntryChange(eventId: string, entry: CallEntry) {
    setEntries((prev) => {
      const next = new Map(prev);
      next.set(eventId, entry);
      return next;
    });
  }

  function handleManualMatch(eventId: string, match: ManualMatch) {
    setManualMatches((prev) => {
      const next = new Map(prev);
      next.set(eventId, match);
      return next;
    });

    // Check if this account already has a logged C1/RCC for the selected week
    if (selectedWeek) {
      fetch(
        `/api/salesforce/check-logged?accountId=${match.accountId}&start=${selectedWeek.start}&end=${selectedWeek.end}`
      )
        .then((res) => res.json())
        .then((data) => {
          if (data.alreadyLogged) {
            setMeetings((prev) =>
              prev.map((m) =>
                m.eventId === eventId ? { ...m, alreadyLogged: true } : m
              )
            );
          }
        })
        .catch(() => {
          // Non-critical — just won't show the flag
        });
    }
  }

  // ── Job-backed submit sync ────────────────────────────────────────────────
  // Submitting now creates a `calls_log` background job. The bell tracks
  // progress; when the job completes we hydrate submitResult from the job
  // result and dismiss the meetings that succeeded.
  const { jobs, refetch: refetchJobs } = useJobs();
  const syncedCallsLogId = useRef<string | null>(null);

  useEffect(() => {
    const latest = jobs.find((j) => j.kind === "calls_log");
    if (!latest) return;

    if (latest.status === "queued" || latest.status === "running") {
      setSubmitting(true);
      return;
    }

    if (latest.id === syncedCallsLogId.current) return;
    syncedCallsLogId.current = latest.id;

    if (latest.status === "succeeded") {
      const r = (latest.result ?? {}) as SubmitResult;
      setSubmitResult(r);
      setSubmitting(false);
      // Dismiss meetings whose eventId succeeded
      const successfulEventIds = new Set(
        (r.results ?? [])
          .filter((x) => x.success && x.eventId)
          .map((x) => x.eventId as string),
      );
      if (successfulEventIds.size > 0) {
        setDismissedIds((prev) => {
          const next = new Set(prev);
          successfulEventIds.forEach((id) => next.add(id));
          return next;
        });
        setEntries((prev) => {
          const next = new Map(prev);
          successfulEventIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    } else if (latest.status === "failed" || latest.status === "cancelled") {
      setSubmitResult({
        successCount: 0,
        failCount: 0,
        results: [],
      });
      setSubmitting(false);
    }
  }, [jobs]);

  // ── Submit — create Salesforce tasks via background job ──────────────────
  async function handleSubmit() {
    // Collect entries that have a valid type and a matched account
    const toSubmit: Array<{
      eventId: string;
      accountId: string;
      accountName: string;
      callType: "C1" | "RCC";
      commentary: string;
      meetingDate: string;
      followUpDays: number | null;
      notes: string;
    }> = [];

    for (const meeting of meetings) {
      if (dismissedIds.has(meeting.eventId)) continue;
      const entry = entries.get(meeting.eventId);
      if (!entry || !entry.callType) continue;

      const matchIdx = entry.selectedAccountIdx ?? 0;
      const match = meeting.allMatches[matchIdx];
      const manual = manualMatches.get(meeting.eventId);
      if (!match && !manual) continue;

      const accountId = match?.accountId ?? manual!.accountId;
      const accountName = match?.accountName ?? manual!.accountName;

      toSubmit.push({
        eventId: meeting.eventId,
        accountId,
        accountName,
        callType: entry.callType as "C1" | "RCC",
        commentary: entry.commentary,
        meetingDate: meeting.meetingDate,
        followUpDays: entry.followUpDays,
        notes: entry.notes ?? "",
      });
    }

    if (toSubmit.length === 0) return;

    setSubmitting(true);
    setSubmitResult(null);

    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "calls_log",
          input: { entries: toSubmit },
          label: `Log ${toSubmit.length} call${toSubmit.length === 1 ? "" : "s"} to Salesforce`,
          resultRoute: "/calls",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSubmitResult({
          successCount: 0,
          failCount: toSubmit.length,
          results: toSubmit.map((e) => ({
            eventId: e.eventId,
            accountName: e.accountName,
            callType: e.callType,
            success: false,
            error: data.error ?? "Failed to start job",
            followUpCreated: false,
            noteCreated: false,
          })),
        });
        setSubmitting(false);
      } else {
        refetchJobs();
      }
    } catch {
      setSubmitResult({
        successCount: 0,
        failCount: toSubmit.length,
        results: toSubmit.map((e) => ({
          eventId: e.eventId,
          accountName: e.accountName,
          callType: e.callType,
          success: false,
          error: "Network error",
          followUpCreated: false,
          noteCreated: false,
        })),
      });
      setSubmitting(false);
    }
  }

  // ── Disconnect handlers ───────────────────────────────────────────────────
  async function handleSfDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setSfConnected(false);
  }

  async function handleMsDisconnect() {
    await fetch("/api/microsoft/status", { method: "DELETE" });
    setMsConnected(false);
    setMeetings([]);
    setHasAnalyzed(false);
  }

  // ── Count actionable entries ──────────────────────────────────────────────
  const actionableCount = Array.from(entries.entries()).filter(
    ([id, e]) => !dismissedIds.has(id) && (e.callType === "C1" || e.callType === "RCC")
  ).length;

  const bothConnected = sfConnected === true && msConnected === true;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Call Logger"
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
      <PageContent className={actionableCount > 0 ? "pb-24" : ""}>
        {/* Loading */}
        {(sfConnected === null || msConnected === null) && (
          <div className="flex justify-center items-center py-24">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-orange" />
          </div>
        )}

        {/* Connection prompts */}
        {sfConnected === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center mb-6">
            <p className="text-amber-800 font-medium mb-2">
              Salesforce is not connected.
            </p>
            <p className="text-amber-600 text-sm mb-4">
              Connect Salesforce to match calendar events to accounts.
            </p>
            <a
              href="/api/salesforce/connect"
              className="inline-block bg-brand-orange hover:bg-brand-orange-hover text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
            >
              Connect Salesforce
            </a>
          </div>
        )}

        {msConnected === false && sfConnected !== false && (
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

        {/* Main UI — both connected */}
        {bothConnected && (
          <>
            {/* Controls bar */}
            <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
              <div>
                <h2 className="text-xl font-semibold text-navy">
                  Call Logger
                </h2>
                <p className="text-sm text-gray-400 mt-0.5">
                  Analyze your Outlook calendar and log calls to Salesforce
                </p>
              </div>

              <div className="flex items-center gap-4">
                <WeekSelector
                  selected={selectedWeek}
                  completedWeeks={completedWeeks}
                  onChange={(week) => {
                    setSelectedWeek(week);
                    setMeetings([]);
                    setEntries(new Map());
                    setHasAnalyzed(false);
                    setSubmitResult(null);
                  }}
                />
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="bg-brand-orange hover:bg-brand-orange-hover disabled:opacity-50 text-white font-semibold px-6 py-2 rounded-lg transition-colors text-sm"
                >
                  {analyzing ? "Analyzing..." : "Analyze Week"}
                </button>
              </div>
            </div>

            {/* Error */}
            {analyzeError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 text-sm text-red-700">
                {analyzeError}
              </div>
            )}

            {/* Loading spinner */}
            {analyzing && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-orange" />
                <p className="text-sm text-gray-400">
                  Fetching calendar events and matching to Salesforce...
                </p>
              </div>
            )}

            {/* Results table */}
            {!analyzing && hasAnalyzed && (
              <>
                <div className="text-sm text-gray-400 mb-3">
                  {meetings.length} external meeting
                  {meetings.length !== 1 ? "s" : ""} found
                  {dismissedIds.size > 0 && (
                    <span className="ml-2 text-gray-300">
                      ({dismissedIds.size} dismissed)
                    </span>
                  )}
                </div>
                <CallLoggerTable
                  meetings={meetings}
                  entries={entries}
                  onEntryChange={handleEntryChange}
                  dismissedIds={dismissedIds}
                  onDismiss={handleDismiss}
                  manualMatches={manualMatches}
                  onManualMatch={handleManualMatch}
                />
              </>
            )}

            {/* Prompt to analyze if not yet done */}
            {!analyzing && !hasAnalyzed && !analyzeError && (
              <div className="text-center py-16 text-gray-400">
                <div className="text-5xl mb-4">📅</div>
                <p className="font-medium">Select a week and click "Analyze Week"</p>
                <p className="text-sm mt-1">
                  We'll pull your Outlook calendar and match meetings to Salesforce accounts
                </p>
              </div>
            )}

            {/* Submit result banner */}
            {submitResult && (
              <div
                className={`mt-4 rounded-lg p-4 text-sm ${
                  submitResult.failCount === 0
                    ? "bg-green-50 border border-green-200 text-green-700"
                    : "bg-amber-50 border border-amber-200 text-amber-700"
                }`}
              >
                {submitResult.successCount > 0 && (
                  <span>
                    {submitResult.successCount} call
                    {submitResult.successCount !== 1 ? "s" : ""} logged
                    successfully to Salesforce.{" "}
                    {(submitResult.results.filter((r) => r.followUpCreated).length > 0 ||
                      submitResult.results.filter((r) => r.noteCreated).length > 0) && (
                      <span>
                        (
                        {submitResult.results.filter((r) => r.followUpCreated).length > 0 && (
                          <span>
                            {submitResult.results.filter((r) => r.followUpCreated).length}{" "}
                            follow-up task{submitResult.results.filter((r) => r.followUpCreated).length !== 1 ? "s" : ""}
                          </span>
                        )}
                        {submitResult.results.filter((r) => r.followUpCreated).length > 0 &&
                          submitResult.results.filter((r) => r.noteCreated).length > 0 && ", "}
                        {submitResult.results.filter((r) => r.noteCreated).length > 0 && (
                          <span>
                            {submitResult.results.filter((r) => r.noteCreated).length}{" "}
                            note{submitResult.results.filter((r) => r.noteCreated).length !== 1 ? "s" : ""}
                          </span>
                        )}
                        {" "}created)
                      </span>
                    )}
                  </span>
                )}
                {submitResult.failCount > 0 && (
                  <span>
                    {submitResult.failCount} failed —{" "}
                    {submitResult.results
                      .filter((r) => !r.success)
                      .map((r) => `${r.accountName}: ${r.error}`)
                      .join("; ")}
                  </span>
                )}
                <button
                  className="ml-4 underline text-xs opacity-70 hover:opacity-100"
                  onClick={() => setSubmitResult(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Submit bar (sticky footer) */}
            {actionableCount > 0 && (
              <div className="fixed bottom-0 left-0 right-0 bg-navy shadow-2xl px-8 py-4 flex items-center justify-between">
                <span className="text-white text-sm">
                  <strong>{actionableCount}</strong> call
                  {actionableCount !== 1 ? "s" : ""} ready to log
                </span>
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setEntries(new Map());
                    }}
                    className="text-gray-300 hover:text-white text-sm px-4 py-2"
                  >
                    Clear all
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={submitting}
                    className="bg-brand-orange hover:bg-brand-orange-hover disabled:opacity-50 text-white font-semibold px-6 py-2 rounded-lg transition-colors text-sm"
                  >
                    {submitting
                      ? "Submitting..."
                      : `Log ${actionableCount} call${actionableCount !== 1 ? "s" : ""} to Salesforce`}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </PageContent>
    </>
  );
}
