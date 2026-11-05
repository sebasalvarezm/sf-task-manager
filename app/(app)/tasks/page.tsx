"use client";

import { useEffect, useMemo, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SalesforceTask } from "@/lib/salesforce";
import { WeekRange, generateWeeks, currentWeekIndex } from "@/app/components/WeekSelector";
import WeekPicker from "@/app/components/WeekPicker";
import { addDays, format } from "date-fns";

import TaskTable, { TaskAction } from "@/app/components/TaskTable";
import { keepAfterFailure } from "@/lib/task-apply";
import { shortDay, splitForSchedule, type ScheduledItem } from "@/lib/scheduled-actions-core";
import ConnectSalesforce from "@/app/components/ConnectSalesforce";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Spinner } from "@/app/components/ui/Spinner";
import { Alert } from "@/app/components/ui/Alert";
import { RefreshCw } from "lucide-react";

/** The Monday-to-Sunday range the task filter uses, from the picker's Monday. */
function weekFromStart(start: string): WeekRange {
  const end = format(addDays(new Date(`${start}T12:00:00`), 6), "yyyy-MM-dd");
  return { label: `${start} – ${end}`, start, end };
}

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

// The last submitted batch, kept until Salesforce confirms it. If the page
// loses the queue for any reason, it is restored from here on the next load.
const SUBMITTED_BATCH_KEY = "submitted_task_actions_v1";
const APPLY_BATCH = 25;
const SIGNED_OUT = "SIGNED_OUT";
const SIGNED_OUT_TEXT = "Your login expired.";

function saveSubmittedBatch(list: TaskAction[]) {
  try {
    localStorage.setItem(SUBMITTED_BATCH_KEY, JSON.stringify(list));
  } catch {
    // non-critical
  }
}
function clearSubmittedBatch() {
  try {
    localStorage.removeItem(SUBMITTED_BATCH_KEY);
  } catch {
    // non-critical
  }
}
function loadSubmittedBatch(): TaskAction[] {
  try {
    const raw = localStorage.getItem(SUBMITTED_BATCH_KEY);
    const list = raw ? (JSON.parse(raw) as TaskAction[]) : [];
    return Array.isArray(list) ? list.filter((a) => a && typeof a.taskId === "string") : [];
  } catch {
    return [];
  }
}

/** JSON body of a response, or null when the server sent something else (a login or error page). */
type ApiJson = { error?: string; tasks?: SalesforceTask[] } & Record<string, unknown>;
async function readJson(res: Response): Promise<ApiJson | null> {
  if (res.redirected && /\/login/.test(res.url)) return { error: SIGNED_OUT };
  return (await res.json().catch(() => null)) as ApiJson | null;
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

  // Actions from a submit that never got confirmed. They are checked against
  // Salesforce once tasks load, so one that did run is never queued twice.
  const unconfirmedRef = useRef<TaskAction[]>([]);
  useEffect(() => {
    const restored = loadDraftActions();
    const unconfirmed = loadSubmittedBatch().filter((a) => !restored.has(a.taskId));
    for (const a of unconfirmed) restored.set(a.taskId, a);
    unconfirmedRef.current = unconfirmed;
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

  // ── Submit Monday: RCEs on a future week's tasks wait for that Monday ───────
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [scheduledPaused, setScheduledPaused] = useState(false);
  const [scheduleNote, setScheduleNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState<string | null>(null);
  const waitingByTask = useMemo(() => new Map(scheduled.filter((i) => i.status === "scheduled").map((i) => [i.taskId, i])), [scheduled]);

  const loadScheduled = useCallback(async () => {
    try {
      const res = await fetch("/api/salesforce/scheduled");
      const data = await readJson(res);
      if (res.ok && data && Array.isArray(data.items)) {
        setScheduled(data.items as unknown as ScheduledItem[]);
        setScheduledPaused(Boolean((data.settings as { paused?: boolean } | undefined)?.paused));
      }
    } catch {
      // The page still works; the waiting list just does not show.
    }
  }, []);

  // A task already waiting for its Monday cannot be queued again.
  useEffect(() => {
    if (waitingByTask.size === 0) return;
    setActions((prev) => {
      const clash = [...prev.keys()].filter((id) => waitingByTask.has(id));
      if (clash.length === 0) return prev;
      const next = new Map(prev);
      for (const id of clash) next.delete(id);
      return next;
    });
  }, [waitingByTask]);

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
        if (data.connected) {
          loadTasks();
          void loadScheduled();
        }
      } else {
        // A failed status check means "can't tell": show the connect
        // prompt rather than "Checking connection…" forever.
        setConnected(false);
      }
    } catch {
      setConnected(false);
    }
  }

  /** Loads open tasks from Salesforce. Returns the fresh list, or null when it failed. */
  const loadTasks = useCallback(async (): Promise<SalesforceTask[] | null> => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const res = await fetch("/api/salesforce/tasks");
      const data = await readJson(res);
      if (!res.ok || !data) {
        if (data?.error === "NOT_CONNECTED") {
          setConnected(false);
          return null;
        }
        throw new Error(data?.error === SIGNED_OUT ? SIGNED_OUT_TEXT : data?.error ?? `The server answered ${res.status}`);
      }
      const tasks: SalesforceTask[] = data.tasks ?? [];
      setAllTasks(tasks);
      setSelectedWeek((prev) => prev ?? generateWeeks()[currentWeekIndex()]);
      return tasks;
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "Unexpected error");
      return null;
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allTasks.length === 0 || unconfirmedRef.current.length === 0) return;
    const notRun = new Set(keepAfterFailure(unconfirmedRef.current, allTasks, false).map((a) => a.taskId));
    const ran = unconfirmedRef.current.filter((a) => !notRun.has(a.taskId));
    unconfirmedRef.current = [];
    clearSubmittedBatch();
    if (ran.length === 0) return;
    setActions((prev) => {
      const next = new Map(prev);
      for (const a of ran) next.delete(a.taskId);
      return next;
    });
  }, [allTasks]);

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
  // Accounts already classified this visit. Sending a nudge removes one task,
  // which changes the account list; that used to blank every chip and
  // re-classify the whole week, and the panel waited on it before opening the
  // next one. Now only accounts not seen yet are classified, and results merge.
  const classifiedRef = useRef<Set<string>>(new Set());
  const weekAccountKey = Array.from(new Set(weekTasks.map((t) => t.AccountId).filter(Boolean))).sort().join(",");
  useEffect(() => {
    const missing = weekAccountKey ? weekAccountKey.split(",").filter((id) => !classifiedRef.current.has(id)) : [];
    if (missing.length === 0) {
      setNudges((prev) => prev ?? {});
      return;
    }
    let cancelled = false;
    fetch("/api/nudges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "classify", accountIds: missing }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        for (const id of missing) classifiedRef.current.add(id);
        setNudges((prev) => ({ ...(prev ?? {}), ...(data.nudges ?? {}) }));
      })
      .catch(() => {
        if (!cancelled) setNudges((prev) => prev ?? {});
      });
    return () => {
      cancelled = true;
    };
  }, [weekAccountKey]);
  const [nudgeTask, setNudgeTask] = useState<SalesforceTask | null>(null);
  const nudgeQueue = weekTasks.filter((t) => t.AccountId && nudges?.[t.AccountId] && !actions.has(t.Id));
  function nextNudgeAfter(after: SalesforceTask): SalesforceTask | null {
    const rest = nudgeQueue.filter((t) => t.Id !== after.Id);
    const idx = nudgeQueue.findIndex((t) => t.Id === after.Id);
    return rest[idx] ?? rest[0] ?? null;
  }
  function openNextNudge(after: SalesforceTask) {
    setNudgeTask(nextNudgeAfter(after));
  }
  const upcomingNudge = nudgeTask ? nextNudgeAfter(nudgeTask) : null;

  const bsCandidates = weekTasks.filter((t) => looksBs(t) && !actions.has(t.Id) && !waitingByTask.has(t.Id));

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
    if (waitingByTask.has(taskId)) return;
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
      void submitQueue(actionsToExecute);
    }
  }

  /**
   * Submit: RCEs on a future week's tasks are scheduled for that week's Monday
   * (Weekly Outreach rows added now, Salesforce at 7am that Monday); everything
   * else applies now. If scheduling fails, nothing at all is submitted and the
   * queue stays as it is.
   */
  async function submitQueue(list: TaskAction[]) {
    setConfirmDeleteCount(null);
    const { now, later } = splitForSchedule(list);
    if (later.length > 0) {
      setApplying(true);
      setApplyResult(null);
      setScheduleNote(null);
      try {
        const res = await fetch("/api/salesforce/scheduled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "schedule", actions: later }),
        });
        const data = await readJson(res);
        if (!res.ok || !data || !Array.isArray(data.items)) {
          const why = data?.error === SIGNED_OUT ? SIGNED_OUT_TEXT : data?.error ?? `The server answered ${res.status}`;
          setApplyResult({ successCount: 0, failCount: 0, results: [], message: `Nothing was submitted (${why}). Your queue is untouched; press Submit again.` });
          setApplying(false);
          return;
        }
        setScheduled(data.items as unknown as ScheduledItem[]);
        const done = (data.scheduled as Array<{ taskId: string; runOn: string }>) ?? [];
        const rejected = (data.rejected as Array<{ taskId: string; accountName: string | null; reason: string; code?: string }>) ?? [];
        const warnings = (data.weeklyWarnings as string[]) ?? [];
        // Scheduled ones leave the queue, and so do stale ones (the task changed
        // in Salesforce). One whose week started meanwhile stays queued.
        const leaving = new Set([...done.map((d) => d.taskId), ...rejected.filter((r) => r.code === "changed").map((r) => r.taskId)]);
        setActions((prev) => {
          const next = new Map(prev);
          for (const id of leaving) next.delete(id);
          return next;
        });
        const mondays = [...new Set(done.map((d) => d.runOn))].sort().map(shortDay);
        const parts: string[] = [];
        if (done.length) parts.push(`${done.length} RCE${done.length !== 1 ? "s" : ""} scheduled for ${mondays.join(" and ")} at 7am. Their rows are in that week's Weekly Outreach now; Salesforce is updated that morning.`);
        if (rejected.length) parts.push(`Not scheduled: ${rejected.map((r) => `${r.accountName ?? "Task"} (${r.reason})`).join("; ")}`);
        if (warnings.length) parts.push(`Weekly Outreach needs a look: ${warnings.join("; ")}. Salesforce will still be updated on Monday.`);
        setScheduleNote({ tone: rejected.length || warnings.length ? "warn" : "ok", text: parts.join(" ") });
      } catch (err) {
        setApplyResult({ successCount: 0, failCount: 0, results: [], message: `Nothing was submitted (${err instanceof Error ? err.message : "network error"}). Your queue is untouched; press Submit again.` });
        setApplying(false);
        return;
      }
      if (now.length === 0) {
        setApplying(false);
        return;
      }
    }
    await executeActions(now);
  }

  async function cancelWaiting(ids: string[]) {
    setScheduleBusy("cancel");
    try {
      const res = await fetch("/api/salesforce/scheduled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", ids }),
      });
      const data = await readJson(res);
      if (!res.ok || !data) throw new Error(data?.error ?? `The server answered ${res.status}`);
      setScheduled((data.items as unknown as ScheduledItem[]) ?? []);
      const kept = (data.rowsKept as string[]) ?? [];
      setScheduleNote({
        tone: kept.length ? "warn" : "ok",
        text: `${ids.length === 1 ? "Taken off the schedule" : `${ids.length} taken off the schedule`}. Nothing was written to Salesforce.${kept.length ? ` The Weekly Outreach row stays for ${kept.join(", ")} because you had started on it.` : ""}`,
      });
    } catch (err) {
      setScheduleNote({ tone: "warn", text: `Could not cancel: ${err instanceof Error ? err.message : "network error"}.` });
    } finally {
      setScheduleBusy(null);
    }
  }

  async function recordWaitingNow(ids: string[]) {
    setScheduleBusy("run");
    try {
      // 40 per request keeps each one well inside the server's time limit.
      const sum = { recorded: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < ids.length; i += 40) {
        const res = await fetch("/api/salesforce/scheduled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "run_now", ids: ids.slice(i, i + 40) }),
        });
        const data = await readJson(res);
        if (!res.ok || !data) throw new Error(data?.error ?? `The server answered ${res.status}`);
        setScheduled((data.items as unknown as ScheduledItem[]) ?? []);
        const part = data.summary as { recorded: number; skipped: number; failed: number };
        sum.recorded += part.recorded;
        sum.skipped += part.skipped;
        sum.failed += part.failed;
      }
      setScheduleNote({
        tone: sum.skipped || sum.failed ? "warn" : "ok",
        text: `Recorded in Salesforce now: ${sum.recorded}.${sum.skipped ? ` Skipped: ${sum.skipped} (see below).` : ""}${sum.failed ? ` Failed: ${sum.failed} (see below).` : ""}`,
      });
      await loadTasks();
    } catch (err) {
      setScheduleNote({ tone: "warn", text: `Could not record: ${err instanceof Error ? err.message : "network error"}.` });
    } finally {
      setScheduleBusy(null);
    }
  }

  async function togglePause() {
    setScheduleBusy("pause");
    try {
      const res = await fetch("/api/salesforce/scheduled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "settings", paused: !scheduledPaused }),
      });
      const data = await readJson(res);
      if (!res.ok || !data) throw new Error(data?.error ?? `The server answered ${res.status}`);
      setScheduledPaused(Boolean((data.settings as { paused?: boolean } | undefined)?.paused));
    } catch (err) {
      setScheduleNote({ tone: "warn", text: `Could not change the pause switch: ${err instanceof Error ? err.message : "network error"}.` });
    } finally {
      setScheduleBusy(null);
    }
  }

  async function executeActions(actionsToExecute: TaskAction[]) {
    setConfirmDeleteCount(null);
    setApplying(true);
    setApplyResult(null);
    // A copy of the batch survives until Salesforce confirms it, so nothing
    // typed in is ever lost to a failed submit.
    saveSubmittedBatch(actionsToExecute);

    const done: ApplyResult = { successCount: 0, failCount: 0, results: [], queueWarnings: [] };
    let unsent: TaskAction[] = [];
    let problem: string | null = null;
    let signedOut = false;

    // Small batches: one request per 25 actions keeps each well under the
    // server's 5 minute limit, and a failure only leaves one batch unclear.
    for (let i = 0; i < actionsToExecute.length; i += APPLY_BATCH) {
      const batch = actionsToExecute.slice(i, i + APPLY_BATCH);
      try {
        const res = await fetch("/api/salesforce/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actions: batch }),
        });
        const data = (await readJson(res)) as unknown as (ApplyResult & { error?: string }) | null;
        if (res.ok && data && Array.isArray(data.results)) {
          done.successCount += data.successCount;
          done.failCount += data.failCount;
          done.results.push(...data.results);
          done.queueWarnings!.push(...(data.queueWarnings ?? []));
          continue;
        }
        // Signed out: the request never reached Salesforce, so nothing ran.
        if (res.status === 401 || data?.error === SIGNED_OUT) signedOut = true;
        problem = data?.error && data.error !== SIGNED_OUT ? data.error : `The server answered ${res.status}`;
      } catch (err) {
        problem = err instanceof Error ? err.message : "Network error";
      }
      unsent = actionsToExecute.slice(i);
      break;
    }

    const fresh = await loadTasks();

    if (!problem) {
      clearSubmittedBatch();
      // Only what was applied leaves the queue (an RCE whose week started while
      // it was being scheduled stays queued).
      const applied = new Set(actionsToExecute.map((a) => a.taskId));
      setActions((prev) => new Map([...prev].filter(([id]) => !applied.has(id))));
      setApplyResult(done);
      setApplying(false);
      return;
    }

    // Something did not come back cleanly. Keep every action that has not
    // run: signed out means none of the unsent ones ran; otherwise an action
    // counts as not run while its task is still open on the same due date.
    // Ones that clearly ran are dropped so Apply can't repeat them.
    const keep = keepAfterFailure(unsent, fresh, signedOut);
    const next = new Map<string, TaskAction>();
    for (const a of keep) next.set(a.taskId, a);
    // Anything that was not part of this batch stays queued too.
    const inBatch = new Set(actionsToExecute.map((a) => a.taskId));
    setActions((prev) => {
      const merged = new Map([...prev].filter(([id]) => !inBatch.has(id)));
      for (const [id, a] of next) merged.set(id, a);
      return merged;
    });
    if (next.size === 0) clearSubmittedBatch();
    else saveSubmittedBatch(keep);

    const ranUnclear = unsent.length - keep.length;
    done.message = signedOut
      ? `${SIGNED_OUT_TEXT} Your ${keep.length} queued action${keep.length !== 1 ? "s are" : " is"} still here and nothing was sent for ${keep.length !== 1 ? "them" : "it"}. Log in again in a new tab, come back, and press Apply.`
      : !fresh
        ? `The batch didn't finish cleanly (${problem}) and the task list could not be reloaded, so all ${keep.length} unsent action${keep.length !== 1 ? "s were" : " was"} kept in the queue. Some may already have run in Salesforce: refresh and check before applying again.`
        : `The batch didn't finish cleanly (${problem}). ${keep.length} action${keep.length !== 1 ? "s that had not run are" : " that had not run is"} still queued${ranUnclear > 0 ? `, and ${ranUnclear} that already went through in Salesforce ${ranUnclear !== 1 ? "were" : "was"} taken off the queue` : ""}. Press Apply again when ready.`;
    setApplyResult(done);
    setApplying(false);
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

  // What the Submit button will do with the queue.
  const queueSplit = splitForSchedule(Array.from(actions.values()).filter((a) => a.actionType !== "none"));
  const laterMondays = [...new Set(queueSplit.later.map((a) => a.runOn))].sort();
  const laterWhen = laterMondays.length === 1 ? shortDay(laterMondays[0]) : "their Mondays";
  const submitLabel =
    queueSplit.later.length === 0
      ? `Apply ${activeActionCount} action${activeActionCount !== 1 ? "s" : ""}`
      : queueSplit.now.length === 0
        ? `Submit ${queueSplit.later.length} RCE${queueSplit.later.length !== 1 ? "s" : ""} for ${laterWhen}`
        : `Apply ${queueSplit.now.length} now, ${queueSplit.later.length} RCE${queueSplit.later.length !== 1 ? "s" : ""} for ${laterWhen}`;

  // The waiting list and what happened to recent ones, for the panel above the table.
  const waiting = scheduled.filter((i) => i.status === "scheduled");
  const waitingByMonday = [...new Set(waiting.map((i) => i.runOn))].sort().map((runOn) => ({ runOn, count: waiting.filter((i) => i.runOn === runOn).length }));
  const recentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const recentDone = scheduled.filter((i) => i.status !== "scheduled" && i.status !== "cancelled" && (i.finishedAt ?? "") >= recentCutoff);
  const recentProblems = recentDone.filter((i) => i.status !== "done");
  const retrying = waiting.filter((i) => (i.attempts ?? 0) > 0);

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
              {/* Same week picker as Weekly Outreach. */}
              <WeekPicker
                value={selectedWeek?.start ?? generateWeeks()[currentWeekIndex()].start}
                onChange={(start) => {
                  if (start === selectedWeek?.start) return;
                  if (actions.size > 0 && !window.confirm("You have unsaved queued actions. Switch weeks and discard them?")) return;
                  setSelectedWeek(weekFromStart(start));
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

            {waiting.length > 0 || recentDone.length > 0 || scheduleNote ? (
              <div className="rounded-md border border-line bg-white px-4 py-3 text-sm">
                {waiting.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-ink">
                      {waitingByMonday.map((m) => `${m.count} RCE${m.count !== 1 ? "s" : ""} for ${shortDay(m.runOn)}`).join(" · ")}
                      <span className="text-ink-secondary">
                        {scheduledPaused
                          ? " · paused: nothing is recorded until you resume"
                          : " · recorded in Salesforce at 7am that day; their rows are already in that week's Weekly Outreach"}
                      </span>
                    </p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" disabled={scheduleBusy !== null} onClick={() => void togglePause()}>
                        {scheduledPaused ? "Resume" : "Pause"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={scheduleBusy === "run"}
                        disabled={scheduleBusy !== null}
                        onClick={() => {
                          if (window.confirm(`Record all ${waiting.length} in Salesforce now instead of on their Monday? Each task is completed today and its next task is dated from today.`)) {
                            void recordWaitingNow(waiting.map((i) => i.id));
                          }
                        }}
                      >
                        Record now
                      </Button>
                    </div>
                  </div>
                ) : null}
                {retrying.length > 0 ? (
                  <p className="mt-1 text-warn">Will retry tomorrow at 7am: {retrying.map((i) => `${i.accountName ?? "Task"} (${i.note ?? "Salesforce error"})`).join("; ")}</p>
                ) : null}
                {recentDone.length > 0 ? (
                  <p className={`mt-1 ${recentProblems.length ? "text-warn" : "text-ink-secondary"}`}>
                    Last 7 days: {recentDone.filter((i) => i.status === "done").length} recorded
                    {recentProblems.length ? `, ${recentProblems.length} not recorded: ${recentProblems.map((i) => `${i.accountName ?? "Task"} (${i.note ?? i.status})`).join("; ")}` : "."}
                  </p>
                ) : null}
                {scheduleNote ? (
                  <p className={`mt-1 ${scheduleNote.tone === "warn" ? "text-warn" : "text-ok"}`}>
                    {scheduleNote.text}{" "}
                    <button type="button" className="text-ink-muted underline" onClick={() => setScheduleNote(null)}>Dismiss</button>
                  </p>
                ) : null}
              </div>
            ) : null}

            {tasksLoading ? (
              <Spinner center label="Loading tasks…" />
            ) : (
              <TaskTable
                tasks={weekTasks}
                actions={actions}
                onActionChange={handleActionChange}
                nudges={nudges}
                onOpenNudge={setNudgeTask}
                waiting={waitingByTask}
                onCancelWaiting={(item) => void cancelWaiting([item.id])}
                cancelBusy={scheduleBusy === "cancel"}
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
            {queueSplit.later.length > 0 ? (
              <span className="block text-xs text-ink-secondary">
                RCEs on next week&apos;s tasks go to that week&apos;s Weekly Outreach now and into Salesforce at 7am on {laterWhen}.
              </span>
            ) : null}
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
              {applying ? "Submitting…" : submitLabel}
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
          next={upcomingNudge && upcomingNudge.AccountId && nudges[upcomingNudge.AccountId] ? { task: upcomingNudge, topic: nudges[upcomingNudge.AccountId].topic, via: nudges[upcomingNudge.AccountId].via } : null}
          onClose={() => setNudgeTask(null)}
          onSent={(sent, note, newDate) => {
            // The task was pushed to its new date, or left where it was.
            if (newDate) setAllTasks((prev) => prev.map((t) => (t.Id === sent.Id ? { ...t, ActivityDate: newDate } : t)));
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
                onClick={() => void submitQueue(pendingActions)}
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
  draftNote?: string | null;
  sender: { name: string | null; email: string };
  subject: string;
  thread: Array<{ from: string; email: string; at: string; mine: boolean; text: string }>;
  body: string;
};

/**
 * Drafts prepared this visit, by task id. While Seb reads one nudge the next
 * one is prepared in the background, so Send (or Skip) opens it ready instead
 * of waiting on the thread read and the draft. A failure is dropped from the
 * cache so opening it again retries.
 */
const preparedCache = new Map<string, Promise<PreparedNudge>>();
function prepareNudgeFor(task: SalesforceTask, topic: string, via?: "email" | "call" | "sent"): Promise<PreparedNudge> {
  const hit = preparedCache.get(task.Id);
  if (hit) return hit;
  const p = fetch("/api/nudges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare", accountId: task.AccountId, accountName: task.AccountName, website: task.AccountWebsite, topic, via }),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Could not prepare the nudge");
    return data as PreparedNudge;
  });
  preparedCache.set(task.Id, p);
  p.catch(() => preparedCache.delete(task.Id));
  return p;
}

function NudgePanel(props: {
  task: SalesforceTask;
  topic: string;
  via?: "email" | "call" | "sent";
  remaining: number;
  next: { task: SalesforceTask; topic: string; via?: "email" | "call" | "sent" } | null;
  onClose: () => void;
  onSent: (task: SalesforceTask, note: string | null, newDate: string | null) => void;
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
    prepareNudgeFor(task, props.topic, props.via)
      .then((data) => {
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
  // Get the next one ready while this one is being read.
  const nextId = props.next?.task.Id ?? null;
  useEffect(() => {
    if (!props.next) return;
    const n = props.next;
    const t = window.setTimeout(() => void prepareNudgeFor(n.task, n.topic, n.via).catch(() => undefined), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextId]);

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
      props.onSent(task, data.notes?.length ? `${task.AccountName}: email sent, but ${data.notes.join(" ")}` : null, typeof data.newTaskDate === "string" ? data.newTaskDate : null);
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
              {prepared.draftNote ? <p className="mt-3 text-xs text-warn">{prepared.draftNote}</p> : null}
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
                  Push this task
                </label>
                <input
                  id="nudge-days"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  placeholder="none"
                  className={`h-9 w-20 rounded-sm border px-2 ${daysValid ? "border-line-strong" : "border-danger"}`}
                />
                <span className="text-ink-secondary">{days.trim() === "" ? "days (empty: task stays where it is)" : nextDate ? `days · ${nextDate}` : "days"}</span>
              </div>
              <p className="mt-1 text-xs text-ink-secondary">{prepared.replyToMessageId ? "Replies in the same thread (reply all)." : "Sends as a new email."} On send, this task moves to that date. Nothing is logged as an RCE.</p>
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
