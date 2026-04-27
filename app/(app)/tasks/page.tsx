"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SalesforceTask } from "@/lib/salesforce";
import WeekSelector, { WeekRange, generateWeeks, currentWeekIndex } from "@/app/components/WeekSelector";
import TaskTable, { TaskAction, PortfolioMatch } from "@/app/components/TaskTable";
import ConnectSalesforce from "@/app/components/ConnectSalesforce";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Spinner } from "@/app/components/ui/Spinner";
import { Alert } from "@/app/components/ui/Alert";
import { RefreshCw } from "lucide-react";

// ── Pending-actions auto-save ────────────────────────────────────────────────
// As you fill in delete/reschedule/delay choices we mirror the actions map to
// localStorage so that an accidental tab close doesn't wipe your work. On
// successful Apply we clear it. Pure client-side; no server involvement.
const PENDING_ACTIONS_KEY = "pending_task_actions_v1";

function loadDraftActions(): Map<string, TaskAction> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(PENDING_ACTIONS_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, TaskAction>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveDraftActions(actions: Map<string, TaskAction>) {
  if (typeof window === "undefined") return;
  try {
    if (actions.size === 0) {
      localStorage.removeItem(PENDING_ACTIONS_KEY);
      return;
    }
    const obj: Record<string, TaskAction> = {};
    for (const [k, v] of actions) obj[k] = v;
    localStorage.setItem(PENDING_ACTIONS_KEY, JSON.stringify(obj));
  } catch {
    // localStorage full or unavailable — non-critical
  }
}

// ── Portfolio match localStorage cache ───────────────────────────────────────
const PORTFOLIO_CACHE_KEY = "portfolio_matches_v7";

function getPortfolioCache(): Map<string, PortfolioMatch> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(PORTFOLIO_CACHE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, PortfolioMatch>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveToPortfolioCache(accountId: string, match: PortfolioMatch) {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(PORTFOLIO_CACHE_KEY);
    const obj: Record<string, PortfolioMatch> = raw ? JSON.parse(raw) : {};
    obj[accountId] = { matched: match.matched, group: match.group };
    localStorage.setItem(PORTFOLIO_CACHE_KEY, JSON.stringify(obj));
  } catch {
    // localStorage full or unavailable — non-critical
  }
}

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

export default function TasksPage() {
  return (
    <Suspense fallback={<Spinner center label="Loading…" />}>
      <TasksPageContent />
    </Suspense>
  );
}

function TasksPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [connected, setConnected] = useState<boolean | null>(null);
  const [allTasks, setAllTasks] = useState<SalesforceTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [selectedWeek, setSelectedWeek] = useState<WeekRange | null>(null);
  const [actions, setActions] = useState<Map<string, TaskAction>>(new Map());

  // Drafts live in the browser via localStorage. Because this is a Next.js
  // "use client" component that still SSRs, we cannot use a lazy useState
  // initializer for this — it would run on the server (no window) and
  // permanently lock state to an empty Map. Restore in an effect, then gate
  // the save effect on a flag so it can't overwrite the saved draft with the
  // initial empty Map before restore has happened.
  const [draftRestored, setDraftRestored] = useState(false);

  useEffect(() => {
    const restored = loadDraftActions();
    if (restored.size > 0) setActions(restored);
    setDraftRestored(true);
  }, []);

  useEffect(() => {
    if (!draftRestored) return;
    saveDraftActions(actions);
  }, [actions, draftRestored]);

  const [portfolioMatches, setPortfolioMatches] = useState<Map<string, PortfolioMatch>>(() => getPortfolioCache());
  const fetchingAccounts = useRef<Set<string>>(new Set());

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [confirmDeleteCount, setConfirmDeleteCount] = useState<number | null>(null);
  const [pendingActions, setPendingActions] = useState<TaskAction[]>([]);

  useEffect(() => {
    const sfConnected = searchParams.get("sf_connected");
    const sfError = searchParams.get("sf_error");

    if (sfConnected || sfError) {
      router.replace("/tasks");
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

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    fetchingAccounts.current = new Set();
    setPortfolioMatches(getPortfolioCache());
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
      const tasks: SalesforceTask[] = data.tasks ?? [];
      setAllTasks(tasks);
      setSelectedWeek((prev) => prev ?? generateWeeks()[currentWeekIndex()]);
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setTasksLoading(false);
    }
  }, []);

  function runPortfolioMatching(tasks: SalesforceTask[]) {
    const seen = new Set<string>();
    const toMatch: { accountId: string; accountName: string; accountWebsite: string | null }[] = [];
    for (const task of tasks) {
      if (task.AccountId && task.AccountName && !seen.has(task.AccountId)) {
        seen.add(task.AccountId);
        const existing = portfolioMatches.get(task.AccountId);
        const inFlight = fetchingAccounts.current.has(task.AccountId);
        if (!existing && !inFlight) {
          fetchingAccounts.current.add(task.AccountId);
          toMatch.push({ accountId: task.AccountId, accountName: task.AccountName, accountWebsite: task.AccountWebsite ?? null });
        }
      }
    }
    if (toMatch.length === 0) return;

    setPortfolioMatches((prev) => {
      const next = new Map(prev);
      for (const { accountId } of toMatch) {
        next.set(accountId, { matched: false, group: null, loading: true });
      }
      return next;
    });

    toMatch.forEach(({ accountId, accountName, accountWebsite }, i) => {
      setTimeout(() => {
        fetch("/api/portfolio/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountName, accountWebsite }),
        })
          .then((res) => res.json())
          .then((data) => {
            fetchingAccounts.current.delete(accountId);
            const result = {
              matched: data.matched ?? false,
              group: data.group ?? null,
              unavailable: data.unavailable ?? false,
            };
            setPortfolioMatches((prev) => {
              const next = new Map(prev);
              next.set(accountId, result);
              return next;
            });
            if (!result.unavailable) {
              saveToPortfolioCache(accountId, result);
            }
          })
          .catch(() => {
            fetchingAccounts.current.delete(accountId);
            setPortfolioMatches((prev) => {
              const next = new Map(prev);
              next.set(accountId, { matched: false, group: null, unavailable: true });
              return next;
            });
          });
      }, i * 250);
    });
  }

  const weekTasks = selectedWeek
    ? allTasks.filter((t) => {
        if (!t.ActivityDate) return false;
        return t.ActivityDate >= selectedWeek.start && t.ActivityDate <= selectedWeek.end;
      })
    : [];

  useEffect(() => {
    if (weekTasks.length > 0) {
      runPortfolioMatching(weekTasks);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekTasks]);

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

      setActions(new Map());
      await loadTasks();
    } catch {
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
    setPortfolioMatches(getPortfolioCache());
  }

  const activeActionCount = Array.from(actions.values()).filter(
    (a) => a.actionType !== "none"
  ).length;

  const subtitle =
    connected === true
      ? `${weekTasks.length} task${weekTasks.length !== 1 ? "s" : ""} for selected week${
          allTasks.length > 0 ? ` · ${allTasks.length} total open` : ""
        }`
      : undefined;

  return (
    <>
      <PageHeader
        title="Open Tasks"
        subtitle={subtitle}
        actions={
          connected === true ? (
            <>
              <WeekSelector
                selected={selectedWeek}
                onChange={(week) => {
                  setSelectedWeek(week);
                  setActions(new Map());
                  setApplyResult(null);
                  fetchingAccounts.current = new Set();
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={loadTasks}
                disabled={tasksLoading}
                title="Refresh"
                leftIcon={<RefreshCw className="h-4 w-4" strokeWidth={1.75} />}
              >
                Refresh
              </Button>
              <ConnectSalesforce
                connected={connected === true}
                onDisconnect={handleDisconnect}
              />
            </>
          ) : null
        }
      />

      <PageContent className={activeActionCount > 0 ? "pb-24" : ""}>
        {connected === false && (
          <Alert variant="warn" title="Salesforce is not connected yet">
            Click "Connect Salesforce" in the top-right corner to get started.
            <div className="mt-3">
              <a
                href="/api/salesforce/connect"
                className="inline-block bg-brand hover:bg-brand-hover text-white text-sm font-semibold px-5 py-2 rounded-md transition-colors"
              >
                Connect Salesforce
              </a>
            </div>
          </Alert>
        )}

        {connected === null && <Spinner center label="Checking connection…" />}

        {connected === true && (
          <>
            {tasksError && (
              <Alert variant="danger" title="Failed to load tasks">
                {tasksError}
              </Alert>
            )}

            {tasksLoading ? (
              <Spinner center label="Loading tasks…" />
            ) : (
              <TaskTable
                tasks={weekTasks}
                actions={actions}
                portfolioMatches={portfolioMatches}
                onActionChange={handleActionChange}
              />
            )}

            {applyResult && (
              <Alert
                variant={applyResult.failCount === 0 ? "ok" : "warn"}
                onDismiss={() => setApplyResult(null)}
              >
                {applyResult.successCount > 0 && (
                  <span>
                    {applyResult.successCount} action
                    {applyResult.successCount !== 1 ? "s" : ""} applied
                    successfully.{" "}
                  </span>
                )}
                {applyResult.failCount > 0 && (
                  <span>
                    {applyResult.failCount} action
                    {applyResult.failCount !== 1 ? "s" : ""} failed —{" "}
                    {applyResult.results
                      .filter((r) => !r.success)
                      .map((r) => `${r.accountName}: ${r.error}`)
                      .join("; ")}
                  </span>
                )}
              </Alert>
            )}
          </>
        )}
      </PageContent>

      {/* Apply actions bar — fixed, accounts for 256px sidebar via left-64 */}
      {activeActionCount > 0 && (
        <div className="fixed bottom-0 left-64 right-0 bg-navy shadow-2xl px-8 py-4 flex items-center justify-between z-30">
          <span className="text-white text-sm">
            <strong>{activeActionCount}</strong> action
            {activeActionCount !== 1 ? "s" : ""} queued
          </span>
          <div className="flex gap-3">
            <Button
              variant="ghost"
              onClick={() => setActions(new Map())}
              className="text-gray-300 hover:bg-navy-dark hover:text-white"
            >
              Clear all
            </Button>
            <Button
              onClick={handleApplyClick}
              disabled={applying}
              loading={applying}
            >
              {applying
                ? "Applying…"
                : `Apply ${activeActionCount} action${activeActionCount !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDeleteCount !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full">
            <div className="text-4xl mb-4 text-center">⚠️</div>
            <h2 className="text-lg font-semibold text-ink text-center mb-2">
              Confirm permanent deletion
            </h2>
            <p className="text-sm text-ink-muted text-center mb-6">
              You are about to <strong>permanently delete {confirmDeleteCount} task{confirmDeleteCount !== 1 ? "s" : ""}</strong> from Salesforce.
              This action <strong>cannot be undone</strong>.
            </p>
            <div className="flex gap-3">
              <Button
                variant="secondary"
                onClick={() => setConfirmDeleteCount(null)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => executeActions(pendingActions)}
                className="flex-1"
              >
                Yes, delete permanently
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
