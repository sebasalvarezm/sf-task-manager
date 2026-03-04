"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import WeekSelector, { WeekRange, generateWeeks, currentWeekIndex } from "../components/WeekSelector";
import CallLoggerTable, {
  MeetingRow,
  CallEntry,
  ManualMatch,
} from "../components/CallLoggerTable";
import ConnectSalesforce from "../components/ConnectSalesforce";

type SubmitResult = {
  successCount: number;
  failCount: number;
  results: Array<{
    accountName: string;
    callType: string;
    success: boolean;
    error?: string;
    followUpCreated: boolean;
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
  }

  // ── Submit — create Salesforce tasks ──────────────────────────────────────
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
      });
    }

    if (toSubmit.length === 0) return;

    setSubmitting(true);
    setSubmitResult(null);

    try {
      const res = await fetch("/api/salesforce/log-calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: toSubmit }),
      });

      const data = await res.json();
      setSubmitResult(data);

      // Dismiss only the successfully submitted meetings (keep the rest)
      if (data.successCount > 0) {
        const submittedIds = new Set(toSubmit.map((e) => e.eventId));
        setDismissedIds((prev) => {
          const next = new Set(prev);
          submittedIds.forEach((id) => next.add(id));
          return next;
        });
        setEntries((prev) => {
          const next = new Map(prev);
          submittedIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    } catch {
      setSubmitResult({
        successCount: 0,
        failCount: toSubmit.length,
        results: toSubmit.map((e) => ({
          accountName: e.accountName,
          callType: e.callType,
          success: false,
          error: "Network error",
          followUpCreated: false,
        })),
      });
    } finally {
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

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  // ── Count actionable entries ──────────────────────────────────────────────
  const actionableCount = Array.from(entries.entries()).filter(
    ([id, e]) => !dismissedIds.has(id) && (e.callType === "C1" || e.callType === "RCC")
  ).length;

  const bothConnected = sfConnected === true && msConnected === true;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-3 hover:opacity-90">
            <img
              src="/valstone-logo.png"
              alt="Valstone"
              className="h-8 w-auto rounded"
            />
            <span className="text-sm font-normal text-gray-300">
              Call Logger
            </span>
          </a>
        </div>

        <div className="flex items-center gap-4">
          {/* Microsoft connection badge */}
          {msConnected === true ? (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-2 text-sm text-green-600 font-medium bg-green-50 border border-green-200 rounded-full px-3 py-1">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                Outlook connected
              </span>
              <button
                onClick={handleMsDisconnect}
                className="text-xs text-gray-400 hover:text-red-500 underline"
              >
                Disconnect
              </button>
            </div>
          ) : msConnected === false ? (
            <a
              href="/api/microsoft/connect"
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              Connect Outlook
            </a>
          ) : null}

          <ConnectSalesforce
            connected={sfConnected === true}
            onDisconnect={handleSfDisconnect}
          />
          <button
            onClick={handleLogout}
            className="text-gray-300 hover:text-white text-sm"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main
        className={`flex-1 px-8 py-8 max-w-screen-xl mx-auto w-full${
          actionableCount > 0 ? " pb-24" : ""
        }`}
      >
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
                    {submitResult.results.filter((r) => r.followUpCreated)
                      .length > 0 && (
                      <span>
                        (
                        {
                          submitResult.results.filter((r) => r.followUpCreated)
                            .length
                        }{" "}
                        follow-up task
                        {submitResult.results.filter((r) => r.followUpCreated)
                          .length !== 1
                          ? "s"
                          : ""}{" "}
                        created)
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
      </main>
    </div>
  );
}
