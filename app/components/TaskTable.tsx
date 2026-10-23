"use client";

import { useRef, useState, useCallback, type ReactNode } from "react";
import { SalesforceTask } from "@/lib/salesforce";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskAction = {
  taskId: string;
  accountId: string | null;
  accountName: string | null;
  subject: string;
  currentDate: string;
  actionType: "none" | "hard_delete" | "complete_reschedule" | "delay";
  days: number;
};

// ── Shortcode parser ──────────────────────────────────────────────────────────

function parseShortcode(
  text: string
): Pick<TaskAction, "actionType" | "days"> | null {
  const t = text.trim().toUpperCase();
  if (t === "D") return { actionType: "hard_delete", days: 0 };
  const rce = t.match(/^RCE(\d+)$/);
  if (rce) return { actionType: "complete_reschedule", days: parseInt(rce[1]) };
  const p = t.match(/^P(\d+)$/);
  if (p) return { actionType: "delay", days: parseInt(p[1]) };
  return null;
}

/** The shortcode for an action, so a code set from outside the table (a draft restore, Pre-mark BS) shows in the box. */
function codeFor(action: TaskAction): string {
  if (action.actionType === "hard_delete") return "D";
  if (action.actionType === "complete_reschedule") return `RCE${action.days}`;
  if (action.actionType === "delay") return `P${action.days}`;
  return "";
}

// ── Column indexes (used for keyboard navigation) ─────────────────────────────
// 0=row#, 1=account, 2=sf-link, 3=subject, 4=due-date, 5=next-steps
const FIRST_COL = 1;
const LAST_COL = 5;
const INTERACTIVE_COL = 5;

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  tasks: SalesforceTask[];
  actions: Map<string, TaskAction>;
  onActionChange: (taskId: string, action: TaskAction) => void;
  /** accountId → nudge info; accounts not in it are reconnects. Undefined while loading. */
  nudges?: Record<string, { lastInAt: string; topic: string }>;
  onOpenNudge?: (task: SalesforceTask) => void;
};

function KindChip({ task, nudges, onOpenNudge }: { task: SalesforceTask; nudges?: Record<string, { lastInAt: string; topic: string }>; onOpenNudge?: (task: SalesforceTask) => void }) {
  if (!nudges) return <span className="text-xs text-ink-muted">…</span>;
  const n = task.AccountId ? nudges[task.AccountId] : undefined;
  if (!n) return <span className="text-xs text-ink-secondary">Reconnect</span>;
  const days = Math.max(0, Math.floor((Date.now() - new Date(n.lastInAt).getTime()) / 86_400_000));
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenNudge?.(task);
      }}
      title={`They last wrote ${days} day${days === 1 ? "" : "s"} ago. Open a reply in that thread.`}
      className="rounded-sm bg-info-soft px-2 py-0.5 text-left text-xs font-medium text-info hover:underline"
    >
      Nudge · {n.topic}
    </button>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TaskTable({
  tasks,
  actions,
  onActionChange,
  nudges,
  onOpenNudge,
}: Props) {
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [inputValues, setInputValues] = useState<Map<string, string>>(new Map());
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const [showTooltip, setShowTooltip] = useState(false);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function getAction(taskId: string): TaskAction {
    return (
      actions.get(taskId) ?? {
        taskId,
        accountId: null,
        accountName: null,
        subject: "",
        currentDate: "",
        actionType: "none",
        days: 0,
      }
    );
  }

  function focusCell(row: number, col: number) {
    setActiveCell({ row, col });
    if (col === INTERACTIVE_COL && row >= 0 && row < tasks.length) {
      const ref = inputRefs.current.get(tasks[row].Id);
      if (ref) setTimeout(() => ref.focus(), 0);
    }
  }

  // ── Keyboard navigation ──────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableElement>) => {
      if (!activeCell) return;
      const { row, col } = activeCell;

      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        if (col < LAST_COL) focusCell(row, col + 1);
        else if (row < tasks.length - 1) focusCell(row + 1, FIRST_COL);
      } else if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        if (col > FIRST_COL) focusCell(row, col - 1);
        else if (row > 0) focusCell(row - 1, LAST_COL);
      } else if (e.key === "Enter" && !e.shiftKey && col !== INTERACTIVE_COL) {
        e.preventDefault();
        if (row < tasks.length - 1) focusCell(row + 1, col);
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        if (row > 0) focusCell(row - 1, col);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (row < tasks.length - 1) focusCell(row + 1, col);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (row > 0) focusCell(row - 1, col);
      } else if (e.key === "ArrowRight" && col !== INTERACTIVE_COL) {
        e.preventDefault();
        if (col < LAST_COL) focusCell(row, col + 1);
        else if (row < tasks.length - 1) focusCell(row + 1, FIRST_COL);
      } else if (e.key === "ArrowLeft" && col !== INTERACTIVE_COL) {
        e.preventDefault();
        if (col > FIRST_COL) focusCell(row, col - 1);
        else if (row > 0) focusCell(row - 1, LAST_COL);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeCell, tasks]
  );

  // ── Input handler ─────────────────────────────────────────────────────────────

  function handleInputChange(task: SalesforceTask, value: string) {
    setInputValues((prev) => {
      const next = new Map(prev);
      next.set(task.Id, value);
      return next;
    });

    const parsed = parseShortcode(value);
    onActionChange(task.Id, {
      taskId: task.Id,
      accountId: task.AccountId,
      accountName: task.AccountName,
      subject: task.Subject,
      currentDate: task.ActivityDate,
      actionType: parsed?.actionType ?? "none",
      days: parsed?.days ?? 0,
    });
  }

  // ── Quick-action buttons (mobile cards) ───────────────────────────────────────
  // Shared writer so taps and the text box stay perfectly in sync.
  function writeAction(
    task: SalesforceTask,
    code: string,
    actionType: TaskAction["actionType"],
    days: number
  ) {
    setInputValues((prev) => {
      const next = new Map(prev);
      next.set(task.Id, code);
      return next;
    });
    onActionChange(task.Id, {
      taskId: task.Id,
      accountId: task.AccountId,
      accountName: task.AccountName,
      subject: task.Subject,
      currentDate: task.ActivityDate,
      actionType,
      days,
    });
  }

  // Tapping +7 / +30 accumulates into a "push" (delay). +7 twice → P14.
  function bumpDelay(task: SalesforceTask, delta: number) {
    const current = getAction(task.Id);
    const base = current.actionType === "delay" ? current.days : 0;
    const days = base + delta;
    writeAction(task, `P${days}`, "delay", days);
  }

  // Delete toggles: tap once to arm, tap again to clear.
  function toggleDelete(task: SalesforceTask) {
    if (getAction(task.Id).actionType === "hard_delete") {
      clearAction(task);
    } else {
      writeAction(task, "D", "hard_delete", 0);
    }
  }

  function clearAction(task: SalesforceTask) {
    writeAction(task, "", "none", 0);
  }

  // ── Badge display ─────────────────────────────────────────────────────────────

  // Always one line tall, even when empty, so the buttons below never move
  // when a code appears: stacking +7d or +30d taps needs the target to stay put.
  function renderBadge(taskId: string) {
    const action = getAction(taskId);
    let inner: ReactNode = "\u00a0";
    if (action.actionType === "hard_delete") inner = <span className="text-danger">→ Delete</span>;
    else if (action.actionType === "complete_reschedule") inner = <span className="text-ok">→ RCE in {action.days}d</span>;
    else if (action.actionType === "delay") inner = <span className="text-info">→ Push {action.days}d</span>;
    return <div className="min-h-[16px] text-xs font-normal leading-4">{inner}</div>;
  }

  function getInputBorderClass(taskId: string) {
    const a = getAction(taskId).actionType;
    if (a === "hard_delete") return "border-danger bg-white";
    if (a === "complete_reschedule") return "border-line-strong bg-white";
    if (a === "delay") return "border-line-strong bg-white";
    return "border-line-strong bg-white";
  }

  /** What the box shows: what was typed here, unless the action no longer matches it (set elsewhere). */
  function shownValue(taskId: string): string {
    const typed = inputValues.get(taskId);
    const action = getAction(taskId);
    if (typed !== undefined) {
      const parsed = parseShortcode(typed);
      const matches = parsed ? parsed.actionType === action.actionType && parsed.days === action.days : action.actionType === "none";
      if (matches) return typed;
    }
    return codeFor(action);
  }

  function isInvalidCode(taskId: string) {
    const value = inputValues.get(taskId)?.trim() ?? "";
    return value.length > 0 && parseShortcode(value) === null;
  }

  function quickActions(task: SalesforceTask) {
    const action = getAction(task.Id);
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => toggleDelete(task)} className={`min-h-[34px] rounded-sm border px-2 text-xs font-normal transition-colors ${action.actionType === "hard_delete" ? "border-danger bg-danger-soft text-danger" : "border-danger bg-white text-danger hover:bg-danger-soft"}`}>Delete</button>
        <button type="button" onClick={() => bumpDelay(task, 7)} className={`min-h-[34px] rounded-sm border px-2 text-xs font-normal transition-colors ${action.actionType === "delay" ? "border-ink bg-surface-4 text-ink" : "border-line-strong bg-white text-ink hover:bg-surface-3"}`}>+7d</button>
        <button type="button" onClick={() => bumpDelay(task, 30)} className={`min-h-[34px] rounded-sm border px-2 text-xs font-normal transition-colors ${action.actionType === "delay" ? "border-ink bg-surface-4 text-ink" : "border-line-strong bg-white text-ink hover:bg-surface-3"}`}>+30d</button>
        <button type="button" onClick={() => writeAction(task, "RCE7", "complete_reschedule", 7)} className={`min-h-[34px] rounded-sm border px-2 text-xs font-normal transition-colors ${action.actionType === "complete_reschedule" ? "border-ink bg-surface-4 text-ink" : "border-line-strong bg-white text-ink hover:bg-surface-3"}`}>Complete+Recreate</button>
        <button type="button" onClick={() => clearAction(task)} aria-label="Clear action" tabIndex={action.actionType === "none" ? -1 : 0} className={`min-h-[34px] w-8 rounded-sm border border-line text-ink-secondary hover:bg-surface-3 hover:text-ink transition-colors ${action.actionType === "none" ? "invisible" : ""}`}>×</button>
      </div>
    );
  }

  function isCellActive(row: number, col: number) {
    return activeCell?.row === row && activeCell?.col === col;
  }

  const cellBase = "outline-none";
  const cellActive = "ring-2 ring-inset ring-line-strong";

  // ── Empty state ───────────────────────────────────────────────────────────────

  if (tasks.length === 0) {
    return (
      <div className="text-center py-16 text-ink-secondary">
        <p className="text-sm">No open tasks for this week</p>
        <p className="text-sm mt-1 text-ink-muted">Select a different week to see tasks</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
    {/* ── Desktop: full table (unchanged) ─────────────────────────────────────── */}
    <div className="hidden md:block overflow-x-auto rounded-md border border-line">
      <table
        className="task-table w-full bg-white"
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setActiveCell(null);
        }}
      >
        <thead>
          <tr>
            <th className="w-8" />
            <th>Account / company</th>
            <th>Kind</th>
            <th>Salesforce</th>
            <th>Task subject</th>
            <th>Due date</th>
            <th className="min-w-[420px]">
              <span className="flex items-center gap-1.5">
                Next steps
                {/* ⓘ shortcode help tooltip */}
                <span className="relative inline-block">
                  <button
                    className="w-4 h-4 rounded-sm border border-line text-ink-secondary text-[10px] font-normal flex items-center justify-center hover:bg-surface-3 hover:text-ink focus:outline-none leading-none"
                    onMouseEnter={() => setShowTooltip(true)}
                    onMouseLeave={() => setShowTooltip(false)}
                    onClick={() => setShowTooltip((v) => !v)}
                    tabIndex={-1}
                    aria-label="Shortcode help"
                  >
                    ?
                  </button>
                  {showTooltip && (
                    <div className="absolute right-6 top-0 z-50 w-72 bg-white text-ink text-xs rounded-md p-3 shadow-xl border border-line font-normal">
                      <p className="font-medium mb-2 text-ink">Shortcode reference:</p>
                      <div className="space-y-1.5">
                        <div className="flex gap-2">
                          <span className="text-ink font-mono w-16 shrink-0">D</span>
                          <span className="text-ink-secondary">Hard delete the task permanently</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-ink font-mono w-16 shrink-0">RCE14</span>
                          <span className="text-ink-secondary">Mark complete + new task in 14 days</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-ink font-mono w-16 shrink-0">P30</span>
                          <span className="text-ink-secondary">Push due date back by 30 days</span>
                        </div>
                      </div>
                      <p className="text-ink-muted mt-2 text-xs">Replace the number with any value you want.</p>
                    </div>
                  )}
                </span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, rowIdx) => (
            <tr key={task.Id} className="bg-white">

              {/* Row number */}
              <td className="text-center text-xs text-ink-muted font-mono tabular-nums w-8">{rowIdx + 1}</td>

              {/* Account Name — col 1 */}
              <td
                tabIndex={0}
                onClick={() => setActiveCell({ row: rowIdx, col: 1 })}
                onFocus={() => setActiveCell({ row: rowIdx, col: 1 })}
                className={`${cellBase} cursor-default ${isCellActive(rowIdx, 1) ? cellActive : ""}`}
              >
                <span className="font-medium text-ink text-sm">
                  {task.AccountName ?? <span className="text-ink-muted italic text-sm font-normal">No account</span>}
                </span>
              </td>

              <td className={cellBase}>
                <KindChip task={task} nudges={nudges} onOpenNudge={onOpenNudge} />
              </td>

              {/* Salesforce link — col 2 */}
              <td
                tabIndex={0}
                onClick={() => setActiveCell({ row: rowIdx, col: 2 })}
                onFocus={() => setActiveCell({ row: rowIdx, col: 2 })}
                className={`${cellBase} ${isCellActive(rowIdx, 2) ? cellActive : ""}`}
              >
                {task.AccountUrl ? (
                  <a
                    href={task.AccountUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-info underline hover:text-ink text-sm font-normal underline-offset-2"
                  >
                    Open ↗
                  </a>
                ) : (
                  <span className="text-ink-muted text-sm">—</span>
                )}
              </td>

              {/* Task Subject — col 3 */}
              <td
                tabIndex={0}
                onClick={() => setActiveCell({ row: rowIdx, col: 3 })}
                onFocus={() => setActiveCell({ row: rowIdx, col: 3 })}
                className={`${cellBase} cursor-default ${isCellActive(rowIdx, 3) ? cellActive : ""}`}
              >
                <span className="text-ink-secondary text-sm">{task.Subject}</span>
              </td>

              {/* Due Date — col 4, hyperlinked to company website */}
              <td
                tabIndex={0}
                onClick={() => setActiveCell({ row: rowIdx, col: 4 })}
                onFocus={() => setActiveCell({ row: rowIdx, col: 4 })}
                className={`${cellBase} ${isCellActive(rowIdx, 4) ? cellActive : ""}`}
              >
                {task.ActivityDate ? (
                  task.AccountWebsite ? (
                    <a
                      href={task.AccountWebsite.startsWith("http") ? task.AccountWebsite : `https://${task.AccountWebsite}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm text-info underline hover:text-ink underline-offset-2 tabular-nums"
                    >
                      {task.ActivityDate}
                    </a>
                  ) : (
                    <span className="text-sm text-ink-secondary tabular-nums">{task.ActivityDate}</span>
                  )
                ) : (
                  <span className="text-ink-muted text-sm">—</span>
                )}
              </td>

              {/* Next Steps shortcode input — col 5 */}
              <td
                tabIndex={-1}
                onClick={() => focusCell(rowIdx, INTERACTIVE_COL)}
                className={`p-1.5 ${cellBase} ${isCellActive(rowIdx, INTERACTIVE_COL) ? cellActive : ""}`}
              >
                <div className="flex flex-col gap-1.5">
                  <input
                    ref={(el) => {
                      if (el) inputRefs.current.set(task.Id, el);
                      else inputRefs.current.delete(task.Id);
                    }}
                    type="text"
                    value={shownValue(task.Id)}
                    placeholder="D / RCE14 / P30"
                    onChange={(e) => handleInputChange(task, e.target.value)}
                    onFocus={() => setActiveCell({ row: rowIdx, col: INTERACTIVE_COL })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (rowIdx < tasks.length - 1) focusCell(rowIdx + 1, INTERACTIVE_COL);
                      } else if (e.key === "Enter" && e.shiftKey) {
                        e.preventDefault();
                        if (rowIdx > 0) focusCell(rowIdx - 1, INTERACTIVE_COL);
                      }
                    }}
                    className={`w-full border rounded-sm px-2 py-1 text-sm focus:outline-none focus:border-ink focus:ring-2 focus:ring-surface-4 transition-colors ${getInputBorderClass(task.Id)}`}
                  />
                  {isInvalidCode(task.Id) && <span className="text-xs font-normal text-danger" role="alert">Invalid code. Use D, P7, P30, RCE7, RCE12, etc.</span>}
                  {renderBadge(task.Id)}
                  {quickActions(task)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    {/* ── Mobile: one card per task (no horizontal scroll) ─────────────────────── */}
    <div className="md:hidden space-y-3">
      {tasks.map((task, rowIdx) => {
        const action = getAction(task.Id);
        const website = task.AccountWebsite
          ? task.AccountWebsite.startsWith("http")
            ? task.AccountWebsite
            : `https://${task.AccountWebsite}`
          : null;
        return (
          <div
            key={task.Id}
            className="rounded-md border border-line bg-white p-4"
          >
            {/* Company name */}
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-ink text-base leading-snug">
                {task.AccountName ?? (
                  <span className="text-ink-muted italic font-normal">No account</span>
                )}
              </span>
              <span className="text-xs text-ink-muted font-mono tabular-nums shrink-0 mt-0.5">
                #{rowIdx + 1}
              </span>
            </div>

            <div className="mt-1">
              <KindChip task={task} nudges={nudges} onOpenNudge={onOpenNudge} />
            </div>

            {/* Meta chips: due date and SF link */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-sm">
              {task.ActivityDate &&
                (website ? (
                  <a
                    href={website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-info underline hover:text-ink underline-offset-2 tabular-nums"
                  >
                    {task.ActivityDate}
                  </a>
                ) : (
                  <span className="text-ink-secondary tabular-nums">{task.ActivityDate}</span>
                ))}
              {task.AccountUrl && (
                <a
                  href={task.AccountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-info underline hover:text-ink font-normal underline-offset-2"
                >
                  Open in Salesforce ↗
                </a>
              )}
            </div>

            {/* Quick-action buttons — taps accumulate into the box below */}
            <div className="flex items-center gap-2 mt-3">
              <button
                type="button"
                onClick={() => toggleDelete(task)}
                className={`flex-1 min-h-[44px] rounded-sm border text-sm font-normal transition-colors ${
                  action.actionType === "hard_delete"
                    ? "border-danger bg-danger-soft text-danger"
                    : "border-danger bg-white text-danger active:bg-danger-soft"
                }`}
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => bumpDelay(task, 7)}
                className={`flex-1 min-h-[44px] rounded-sm border text-sm font-normal transition-colors ${
                  action.actionType === "delay"
                    ? "border-ink bg-surface-4 text-ink"
                    : "border-line-strong bg-white text-ink active:bg-surface-3"
                }`}
              >
                +7d
              </button>
              <button
                type="button"
                onClick={() => bumpDelay(task, 30)}
                className={`flex-1 min-h-[44px] rounded-sm border text-sm font-normal transition-colors ${
                  action.actionType === "delay"
                    ? "border-ink bg-surface-4 text-ink"
                    : "border-line-strong bg-white text-ink active:bg-surface-3"
                }`}
              >
                +30d
              </button>
              <button
                type="button"
                onClick={() => writeAction(task, "RCE7", "complete_reschedule", 7)}
                className={`flex-[2] min-h-[44px] rounded-sm border px-2 text-sm font-normal transition-colors ${
                  action.actionType === "complete_reschedule"
                    ? "border-ink bg-surface-4 text-ink"
                    : "border-line-strong bg-white text-ink active:bg-surface-3"
                }`}
              >
                Complete+Recreate
              </button>
              {action.actionType !== "none" && (
                <button
                  type="button"
                  onClick={() => clearAction(task)}
                  aria-label="Clear action"
                  className="min-h-[44px] w-11 shrink-0 rounded-sm border border-line bg-white text-ink-secondary text-lg active:bg-surface-3 transition-colors"
                >
                  ×
                </button>
              )}
            </div>

            {/* Text box for custom codes (D / RCE14 / P30) */}
            <input
              type="text"
              inputMode="text"
              value={shownValue(task.Id)}
              placeholder="Or type: D / RCE14 / P30"
              onChange={(e) => handleInputChange(task, e.target.value)}
              className={`w-full border rounded-sm px-3 min-h-[44px] text-sm focus:outline-none focus:border-ink focus:ring-2 focus:ring-surface-4 transition-colors mt-2 ${getInputBorderClass(task.Id)}`}
            />
            {isInvalidCode(task.Id) && <div className="mt-1 text-xs font-normal text-danger" role="alert">Invalid code. Use D, P7, P30, RCE7, RCE12, etc.</div>}
            {renderBadge(task.Id)}
          </div>
        );
      })}
    </div>
    </>
  );
}
