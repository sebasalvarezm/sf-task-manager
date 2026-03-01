"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SalesforceTask } from "@/lib/salesforce";
import WeekSelector, { WeekRange, generateWeeks } from "./components/WeekSelector";
import TaskTable, { TaskAction } from "./components/TaskTable";
import ConnectSalesforce from "./components/ConnectSalesforce";

type ApplyResult = {
  successCount: number;
  failCount: number;
  results: Array<{
    taskId: string;
    accountName: string | null;
    actionType: string;
    success: boolean;
    error?: string;
  }>;
};

// Wrapping in Suspense is required by Next.js when useSearchParams is used
export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-navy" />}>
      <HomePageContent />
    </Suspense>
  );
}

function HomePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── State ───────────────────────────────────────────────────────────────────
  const [connected, setConnected] = useState<boolean | null>(null); // null = loading
  const [allTasks, setAllTasks] = useState<SalesforceTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [selectedWeek, setSelectedWeek] = useState<WeekRange | null>(null);
  const [actions, setActions] = useState<Map<string, TaskAction>>(new Map());

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [confirmDeleteCount, setConfirmDeleteCount] = useState<number | null>(null);
  const [pendingActions, setPendingActions] = useState<TaskAction[]>([]);

  // ── On mount: check Salesforce connection + handle OAuth redirect params ────
  useEffect(() => {
    const sfConnected = searchParams.get("sf_connected");
    const sfError = searchParams.get("sf_error");

    if (sfConnected || sfError) {
      // Clean the URL after OAuth redirect
      router.replace("/");
    }

    checkConnection();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkConnection() {
    try {
      const res = await fetch("/api/salesforce/status");
      if (res.ok) {
        const data = await res.json();
        setConnected(data.connected);
        if (data.connected) loadTasks();
      }
    } catch {
      setConnected(false);
    }
  }

  // ── Load all open tasks from Salesforce ─────────────────────────────────────
  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const res = await fetch("/api/salesforce/tasks");
      if (!res.ok) {
        const err = await res.json();
        if (err.error === "NOT_CONNECTED") {
          setConnected(false);
          return;
        }
        throw new Error(err.error ?? "Failed to load tasks");
      }
      const data = await res.json();
      setAllTasks(data.tasks ?? []);

      // Default to the current week if not already set
      setSelectedWeek((prev) => prev ?? generateWeeks()[4]);
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setTasksLoading(false);
    }
  }, []);

  // ── Filter tasks to the selected week ───────────────────────────────────────
  const weekTasks = selectedWeek
    ? allTasks.filter((t) => {
        if (!t.ActivityDate) return false;
        return t.ActivityDate >= selectedWeek.start && t.ActivityDate <= selectedWeek.end;
      })
    : [];

  // ── Action management ────────────────────────────────────────────────────────
  function handleActionChange(taskId: string, action: TaskAction) {
    setActions((prev) => {
      const next = new Map(prev);
      if (action.actionType === "none") {
        next.delete(taskId);
      } else {
        next.set(taskId, action);
      }
      return next;
    });
  }

  // ── Apply button — gather actions, confirm if deletions, then execute ───────
  function handleApplyClick() {
    const actionsToExecute = Array.from(actions.values()).filter(
      (a) => a.actionType !== "none"
    );

    if (actionsToExecute.length === 0) return;

    const deleteCount = actionsToExecute.filter(
      (a) => a.actionType === "hard_delete"
    ).length;

    setPendingActions(actionsToExecute);

    if (deleteCount > 0) {
      setConfirmDeleteCount(deleteCount);
    } else {
      executeActions(actionsToExecute);
    }
  }

  async function executeActions(actionsToExecute: TaskAction[]) {
    setConfirmDeleteCount(null);
    setApplying(true);
    setApplyResult(null);

    try {
      const res = await fetch("/api/salesforce/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions: actionsToExecute }),
      });

      const data = await res.json();
      setApplyResult(data);

      // Clear all actions and refresh tasks
      setActions(new Map());
      await loadTasks();
    } catch (err) {
      setApplyResult({
        successCount: 0,
        failCount: actionsToExecute.length,
        results: actionsToExecute.map((a) => ({
          taskId: a.taskId,
          accountName: a.accountName,
          actionType: a.actionType,
          success: false,
          error: "Network error",
        })),
      });
    } finally {
      setApplying(false);
    }
  }

  async function handleDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setConnected(false);
    setAllTasks([]);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  const activeActionCount = Array.from(actions.values()).filter(
    (a) => a.actionType !== "none"
  ).length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg"
        style={{ background: "var(--navy)" }}
      >
        <div className="text-2xl font-bold text-white tracking-tight">
          <span style={{ color: "var(--orange)" }}>VAL</span>STONE
          <span className="text-sm font-normal text-gray-300 ml-3">
            Task Manager
          </span>
        </div>

        <div className="flex items-center gap-4">
          <ConnectSalesforce
            connected={connected === true}
            onDisconnect={handleDisconnect}
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
      <main className="flex-1 px-8 py-8 max-w-screen-xl mx-auto w-full">

        {/* Connection prompt */}
        {connected === false && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center mb-8">
            <p className="text-amber-800 font-medium mb-3">
              Salesforce is not connected yet.
            </p>
            <p className="text-amber-600 text-sm mb-4">
              Click "Connect Salesforce" in the top-right corner to get started.
            </p>
            <a
              href="/api/salesforce/connect"
              className="inline-block bg-brand-orange hover:bg-brand-orange-hover text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
            >
              Connect Salesforce
            </a>
          </div>
        )}

        {/* Loading spinner */}
        {connected === null && (
          <div className="flex justify-center items-center py-24">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-orange"></div>
          </div>
        )}

        {/* Main UI — only shown when connected */}
        {connected === true && (
          <>
            {/* Controls bar */}
            <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
              <div>
                <h2 className="text-xl font-semibold text-navy">
                  Open Tasks
                </h2>
                <p className="text-sm text-gray-400 mt-0.5">
                  {weekTasks.length} task{weekTasks.length !== 1 ? "s" : ""} for selected week
                  {allTasks.length > 0 && (
                    <span> · {allTasks.length} total open</span>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-4">
                <WeekSelector
                  selected={selectedWeek}
                  onChange={(week) => {
                    setSelectedWeek(week);
                    setActions(new Map());
                    setApplyResult(null);
                  }}
                />
                <button
                  onClick={loadTasks}
                  disabled={tasksLoading}
                  className="text-sm text-gray-400 hover:text-navy disabled:opacity-50"
                  title="Refresh"
                >
                  ↻
                </button>
              </div>
            </div>

            {/* Error */}
            {tasksError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 text-sm text-red-700">
                Failed to load tasks: {tasksError}
              </div>
            )}

            {/* Tasks loading */}
            {tasksLoading ? (
              <div className="flex justify-center py-16">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-orange"></div>
              </div>
            ) : (
              <TaskTable
                tasks={weekTasks}
                actions={actions}
                onActionChange={handleActionChange}
              />
            )}

            {/* Apply result banner */}
            {applyResult && (
              <div
                className={`mt-4 rounded-lg p-4 text-sm ${
                  applyResult.failCount === 0
                    ? "bg-green-50 border border-green-200 text-green-700"
                    : "bg-amber-50 border border-amber-200 text-amber-700"
                }`}
              >
                {applyResult.successCount > 0 && (
                  <span>
                    ✓ {applyResult.successCount} action
                    {applyResult.successCount !== 1 ? "s" : ""} applied
                    successfully.{" "}
                  </span>
                )}
                {applyResult.failCount > 0 && (
                  <span>
                    ✗ {applyResult.failCount} action
                    {applyResult.failCount !== 1 ? "s" : ""} failed —{" "}
                    {applyResult.results
                      .filter((r) => !r.success)
                      .map((r) => `${r.accountName}: ${r.error}`)
                      .join("; ")}
                  </span>
                )}
                <button
                  className="ml-4 underline text-xs opacity-70 hover:opacity-100"
                  onClick={() => setApplyResult(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Apply actions bar */}
            {activeActionCount > 0 && (
              <div className="fixed bottom-0 left-0 right-0 bg-navy shadow-2xl px-8 py-4 flex items-center justify-between">
                <span className="text-white text-sm">
                  <strong>{activeActionCount}</strong> action
                  {activeActionCount !== 1 ? "s" : ""} queued
                </span>
                <div className="flex gap-3">
                  <button
                    onClick={() => setActions(new Map())}
                    className="text-gray-300 hover:text-white text-sm px-4 py-2"
                  >
                    Clear all
                  </button>
                  <button
                    onClick={handleApplyClick}
                    disabled={applying}
                    className="bg-brand-orange hover:bg-brand-orange-hover disabled:opacity-50 text-white font-semibold px-6 py-2 rounded-lg transition-colors text-sm"
                  >
                    {applying ? "Applying…" : `Apply ${activeActionCount} action${activeActionCount !== 1 ? "s" : ""}`}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Delete Confirmation Modal ─────────────────────────────────── */}
      {confirmDeleteCount !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
            <div className="text-4xl mb-4 text-center">⚠️</div>
            <h2 className="text-lg font-semibold text-navy text-center mb-2">
              Confirm permanent deletion
            </h2>
            <p className="text-sm text-gray-500 text-center mb-6">
              You are about to <strong>permanently delete {confirmDeleteCount} task{confirmDeleteCount !== 1 ? "s" : ""}</strong> from Salesforce.
              This action <strong>cannot be undone</strong>.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteCount(null)}
                className="flex-1 border border-gray-200 rounded-lg py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => executeActions(pendingActions)}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white rounded-lg py-2.5 text-sm font-semibold"
              >
                Yes, delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
