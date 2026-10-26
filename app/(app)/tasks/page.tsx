"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SalesforceTask } from "@/lib/salesforce";
import WeekSelector, { WeekRange, generateWeeks, currentWeekIndex } from "@/app/components/WeekSelector";
import TaskTable, { TaskAction } from "@/app/components/TaskTable";
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
  queueWarnings?: string[];
  /** Set when the batch did not come back cleanly (timeout, server error). */
  message?: string;
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

  useEffect(() => {
    if (actions.size === 0) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [actions.size]);

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
      } else {
        // A failed status check means "can't tell": show the connect
        // prompt rather than "Checking connection…" forever.
        setConnected(false);
      }
    } catch {
      setConnected(false);
    }
  }

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
      const tasks: SalesforceTask[] = data.tasks ?? [];
      setAllTasks(tasks);
      setSelectedWeek((prev) => prev ?? generateWeeks()[currentWeekIndex()]);
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setTasksLoading(false);
    }
  }, []);

  const weekTasks = selectedWeek
    ? allTasks.filter((t) => {
        if (!t.ActivityDate) return false;
        return t.ActivityDate >= selectedWeek.start && t.ActivityDate <= selectedWeek.end;
      })
    : [];

  // Accounts that fail the basics (founded after 2019, or fewer than 20 employees
  // in Salesforce) get pushed four months without reading them one by one.
  const BS_FOUNDED_AFTER = 2019;
  const BS_MIN_EMPLOYEES = 20;
  const BS_PUSH_DAYS = 120;
  const looksBs = (t: SalesforceTask) =>
    (t.AccountFounded != null && t.AccountFounded > BS_FOUNDED_AFTER) ||
    (t.AccountEmployees != null && t.AccountEmployees < BS_MIN_EMPLOYEES);
  // ── Nudges: accounts that wrote in within 45 days ─────────────────────────
  const [nudges, setNudges] = useState<Record<string, { lastInAt: string; topic: string; via?: "email" | "call" | "sent" }> | undefined>(undefined);
  const weekAccountKey = Array.from(new Set(weekTasks.map((t) => t.AccountId).filter(Boolean))).sort().join(",");
  useEffect(() => {
    if (!weekAccountKey) {
      setNudges({});
      return;
    }
    let cancelled = false;
    setNudges(undefined);
    fetch("/api/nudges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "classify", accountIds: weekAccountKey.split(",") }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setNudges(data.nudges ?? {});
      })
      .catch(() => {
        if (!cancelled) setNudges({});
      });
    return () => {
      cancelled = true;
    };
  }, [weekAccountKey]);
  const [nudgeTask, setNudgeTask] = useState<SalesforceTask | null>(null);
  const nudgeQueue = weekTasks.filter((t) => t.AccountId && nudges?.[t.AccountId] && !actions.has(t.Id));
  function openNextNudge(after: SalesforceTask) {
    const rest = nudgeQueue.filter((t) => t.Id !== after.Id);
    const idx = nudgeQueue.findIndex((t) => t.Id === after.Id);
    setNudgeTask(rest[idx] ?? rest[0] ?? null);
  }

  const bsCandidates = weekTasks.filter((t) => looksBs(t) && !actions.has(t.Id));

  function preMarkBs() {
    if (bsCandidates.length === 0) return;
    setActions((prev) => {
      const next = new Map(prev);
      for (const t of bsCandidates) {
        next.set(t.Id, {
          taskId: t.Id,
          accountId: t.AccountId,
          accountName: t.AccountName,
          subject: t.Subject,
          currentDate: t.ActivityDate,
          actionType: "delay",
          days: BS_PUSH_DAYS,
        });
      }
      return next;
    });
  }

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

      const data = (await res.json().catch(() => null)) as
        | (ApplyResult & { error?: string })
        | null;
      if (res.ok && data && Array.isArray(data.results)) {
        setApplyResult(data);
      } else {
        throw new Error(data?.error ?? `The server answered ${res.status}`);
      }
    } catch (err) {
      // A timeout or server error does NOT mean nothing happened: the route
      // runs actions one by one, so some may already be done in Salesforce.
      // Reload from Salesforce instead of marking every row failed, so
      // pressing Apply again can't create duplicate follow-up tasks.
      const reason = err instanceof Error ? err.message : "Network error";
      setApplyResult({
        successCount: 0,
        failCount: 0,
        results: [],
        message: `The batch didn't finish cleanly (${reason}). Some actions may already have run in Salesforce, so the list below was reloaded from Salesforce. Check it before applying again.`,
      });
    } finally {
      setActions(new Map());
      await loadTasks();
      setApplying(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm("Disconnect Salesforce? This signs the whole app out of Salesforce until you reconnect.")) return;
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setConnected(false);
    setAllTasks([]);
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
                  if (actions.size > 0 && !window.confirm("You have unsaved queued actions. Switch weeks and discard them?")) return;
                  setSelectedWeek(week);
                  setActions(new Map());
                  setApplyResult(null);
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={preMarkBs}
                disabled={tasksLoading || bsCandidates.length === 0}
                title={`Queue P${BS_PUSH_DAYS} on every task whose account was founded after ${BS_FOUNDED_AFTER} or has fewer than ${BS_MIN_EMPLOYEES} employees in Salesforce. Rows you already marked are left alone.`}
              >
                Pre-mark BS{bsCandidates.length > 0 ? ` (${bsCandidates.length})` : ""}
              </Button>
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
                onActionChange={handleActionChange}
                nudges={nudges}
                onOpenNudge={setNudgeTask}
              />
            )}

            {applyResult && (
              <Alert
                variant={applyResult.failCount === 0 && !applyResult.message ? "ok" : "warn"}
                onDismiss={() => setApplyResult(null)}
              >
                {applyResult.message && <span>{applyResult.message} </span>}
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
                {(applyResult.queueWarnings?.length ?? 0) > 0 && (
                  <span> Salesforce actions succeeded, but Weekly Outreach needs attention: {applyResult.queueWarnings!.join("; ")}</span>
                )}
              </Alert>
            )}
          </>
        )}
      </PageContent>

      {/* Apply actions bar — fixed; accounts for 256px sidebar via md:left-64 (full-width on mobile) */}
      {activeActionCount > 0 && (
        <div className="fixed bottom-0 left-0 md:left-64 right-0 bg-white border-t border-line px-4 md:px-8 py-3 md:py-4 flex items-center justify-between gap-3 z-30">
          <span className="text-ink text-sm">
            <strong>{activeActionCount}</strong> action
            {activeActionCount !== 1 ? "s" : ""} queued
          </span>
          <div className="flex gap-3">
            <Button
              variant="ghost"
              onClick={() => setActions(new Map())}
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

      {nudgeTask && nudges && nudgeTask.AccountId && nudges[nudgeTask.AccountId] ? (
        <NudgePanel
          key={nudgeTask.Id}
          task={nudgeTask}
          topic={nudges[nudgeTask.AccountId].topic}
          via={nudges[nudgeTask.AccountId].via}
          remaining={nudgeQueue.length}
          onClose={() => setNudgeTask(null)}
          onSent={(sent, note) => {
            setAllTasks((prev) => prev.filter((t) => t.Id !== sent.Id));
            if (note) setTasksError(note);
            openNextNudge(sent);
          }}
          onSkip={(task) => openNextNudge(task)}
        />
      ) : null}

      {/* Delete Confirmation Modal */}
      {confirmDeleteCount !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-md border border-line p-4 sm:p-8 max-w-md w-full">
            <h2 className="text-lg font-normal text-ink text-center mb-2">
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

type PreparedNudge = {
  replyToMessageId: string | null;
  callNotes: { date: string; text: string } | null;
  advice?: string | null;
  sender: { name: string | null; email: string };
  subject: string;
  thread: Array<{ from: string; email: string; at: string; mine: boolean; text: string }>;
  body: string;
};

function NudgePanel(props: {
  task: SalesforceTask;
  topic: string;
  via?: "email" | "call" | "sent";
  remaining: number;
  onClose: () => void;
  onSent: (task: SalesforceTask, note: string | null) => void;
  onSkip: (task: SalesforceTask) => void;
}) {
  const { task } = props;
  const [prepared, setPrepared] = useState<PreparedNudge | null>(null);
  const [body, setBody] = useState("");
  const [days, setDays] = useState("7");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const sendRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/nudges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prepare", accountId: task.AccountId, accountName: task.AccountName, website: task.AccountWebsite, topic: props.topic, via: props.via }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Could not prepare the nudge");
        if (!cancelled) {
          setPrepared(data);
          setBody(data.body ?? "");
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.Id]);

  const daysValue = days.trim() === "" ? null : Number(days.replace(/[^0-9]/g, ""));
  const daysValid = days.trim() === "" || (Number.isFinite(daysValue) && (daysValue ?? 0) > 0);
  const canSend = Boolean(prepared) && body.trim().length > 0 && daysValid && !sending;

  async function send() {
    if (!canSend || !prepared) return;
    if (!armed) {
      setArmed(true);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    setArmed(false);
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/nudges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send",
          replyToMessageId: prepared.replyToMessageId,
          emailSubject: prepared.subject,
          sender: prepared.sender,
          body,
          taskId: task.Id,
          accountId: task.AccountId,
          subject: task.Subject,
          days: daysValue,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Not sent");
      props.onSent(task, data.notes?.length ? `${task.AccountName}: email sent, but ${data.notes.join(" ")}` : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not sent");
    } finally {
      setSending(false);
    }
  }
  useEffect(() => {
    sendRef.current = () => void send();
  });
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nextDate = daysValue ? new Date(Date.now() + daysValue * 86_400_000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/40 sm:items-center sm:justify-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="flex h-[100dvh] w-full flex-col border border-line bg-white sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-lg">
        <div className="flex items-start justify-between gap-2 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg text-ink">{task.AccountName}</h2>
            <p className="truncate text-xs text-ink-secondary">
              {props.via === "sent" ? "Follow-up" : `Nudge · ${props.topic}`}
              {prepared ? ` · to ${prepared.sender.name ?? prepared.sender.email} · ${prepared.replyToMessageId ? prepared.subject : `new email: ${prepared.subject}`}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-3 text-sm">
            {props.remaining > 1 ? (
              <button type="button" className="text-ink-secondary hover:text-ink" onClick={() => props.onSkip(task)}>
                Skip ›
              </button>
            ) : null}
            <button type="button" className="text-ink-secondary hover:text-ink" onClick={props.onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {!prepared && !error ? <Spinner center label="Finding the thread and drafting…" /> : null}
          {prepared ? (
            <>
              {prepared.advice ? (
                <div className="mb-2 rounded-md border border-danger/30 bg-danger-soft p-3 text-sm text-ink">
                  <span className="font-medium text-danger">Maybe don&apos;t send: </span>
                  {prepared.advice}
                </div>
              ) : null}
              {prepared.callNotes ? (
                <div className="mb-2 rounded-md border border-warn/30 bg-warn-soft p-3 text-sm">
                  <p className="mb-1 text-xs font-medium text-warn">Your call notes <span className="font-normal text-ink-secondary">· {prepared.callNotes.date}</span></p>
                  <p className="line-clamp-6 whitespace-pre-wrap text-ink">{prepared.callNotes.text}</p>
                </div>
              ) : null}
              {prepared.thread.length === 0 ? (
                <p className="mb-2 text-xs text-ink-secondary">No email thread with them in Outlook, so this goes as a new email.</p>
              ) : null}
              <div className="space-y-2">
                {prepared.thread.filter((m) => m.text.trim()).map((m, i) => (
                  // Theirs on the left in white with a green edge; yours on the right, tinted blue.
                  <div
                    key={i}
                    className={`rounded-md border p-3 text-sm ${
                      m.mine ? "ml-8 border-info/30 bg-info-soft" : "mr-8 border-line border-l-4 border-l-ok bg-white"
                    }`}
                  >
                    <p className={`mb-1 text-xs font-medium ${m.mine ? "text-info" : "text-ok"}`}>
                      {m.mine ? "You" : m.from || m.email} <span className="font-normal text-ink-secondary">· {m.at.slice(0, 10)}</span>
                    </p>
                    <p className="line-clamp-6 whitespace-pre-wrap text-ink">{m.text}</p>
                  </div>
                ))}
              </div>
              <label className="mt-4 block text-sm text-ink" htmlFor="nudge-body">
                {props.via === "sent" ? "Your follow-up" : "Your nudge"}
              </label>
              <textarea
                id="nudge-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="mt-1 min-h-40 w-full rounded-sm border border-line-strong p-3 text-[15px] leading-6 text-ink focus:border-ink focus:outline-none"
              />
              <div className="mt-3 flex items-center gap-3 text-sm">
                <label htmlFor="nudge-days" className="text-ink">
                  Next task in
                </label>
                <input
                  id="nudge-days"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  placeholder="none"
                  className={`h-9 w-20 rounded-sm border px-2 ${daysValid ? "border-line-strong" : "border-danger"}`}
                />
                <span className="text-ink-secondary">{days.trim() === "" ? "days (empty: no new task)" : nextDate ? `days · ${nextDate}` : "days"}</span>
              </div>
              <p className="mt-1 text-xs text-ink-secondary">{prepared.replyToMessageId ? "Replies in the same thread (reply all)." : "Sends as a new email."} On send, this open task is completed.</p>
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <p className="min-w-0 truncate text-xs text-danger" role="alert">
            {error}
          </p>
          <Button
            loading={sending}
            disabled={!canSend}
            onClick={() => void send()}
            title="Ctrl+Enter also works: once to arm, again to send"
            className={armed ? "!bg-ok !text-white" : undefined}
          >
            {armed ? "Tap again to send" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
