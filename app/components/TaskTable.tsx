"use client";

import { useRef, useState, useCallback } from "react";
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

export type PortfolioMatch = {
  matched: boolean;
  group: string | null;
  unavailable?: boolean;
  loading?: boolean;
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

// ── Column indexes (used for keyboard navigation) ─────────────────────────────
// 0=row#, 1=account, 2=sf-link, 3=subject, 4=due-date, 5=portfolio, 6=next-steps
const FIRST_COL = 1;
const LAST_COL = 6;
const INTERACTIVE_COL = 6;

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  tasks: SalesforceTask[];
  actions: Map<string, TaskAction>;
  portfolioMatches: Map<string, PortfolioMatch>;
  onActionChange: (taskId: string, action: TaskAction) => void;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function TaskTable({
  tasks,
  actions,
  portfolioMatches,
  onActionChange,
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

  // ── Portfolio display ─────────────────────────────────────────────────────────

  function renderPortfolio(task: SalesforceTask) {
    if (!task.AccountId) return <span className="text-gray-300 text-xs">—</span>;
    const match = portfolioMatches.get(task.AccountId);
    if (!match || match.loading) {
      return <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-brand-orange rounded-full animate-spin" />;
    }
    if (match.unavailable) return <span className="text-orange-400 text-xs" title="Portfolio API unavailable">~</span>;
    if (match.matched && match.group) {
      return <span className="text-green-600 text-xs font-medium whitespace-nowrap">✅ {match.group}</span>;
    }
    return <span className="text-gray-400 text-xs">✗</span>;
  }

  // ── Badge display ─────────────────────────────────────────────────────────────

  function renderBadge(taskId: string) {
    const action = getAction(taskId);
    if (action.actionType === "hard_delete")
      return <span className="text-xs text-red-600 font-medium">→ Delete</span>;
    if (action.actionType === "complete_reschedule")
      return <span className="text-xs text-green-600 font-medium">→ RCE in {action.days}d</span>;
    if (action.actionType === "delay")
      return <span className="text-xs text-blue-600 font-medium">→ Push {action.days}d</span>;
    return null;
  }

  function getInputBorderClass(taskId: string) {
    const a = getAction(taskId).actionType;
    if (a === "hard_delete") return "border-red-400 bg-red-50";
    if (a === "complete_reschedule") return "border-green-400 bg-green-50";
    if (a === "delay") return "border-blue-400 bg-blue-50";
    return "border-gray-200 bg-white";
  }

  function isCellActive(row: number, col: number) {
    return activeCell?.row === row && activeCell?.col === col;
  }

  const cellBase = "outline-none";
  const cellActive = "ring-2 ring-inset ring-blue-400";

  // ── Empty state ───────────────────────────────────────────────────────────────

  if (tasks.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <div className="text-5xl mb-4">✓</div>
        <p className="font-medium">No open tasks for this week</p>
        <p className="text-sm mt-1">Select a different week to see tasks</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
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
            <th>Account / Company</th>
            <th>Salesforce</th>
            <th>Task Subject</th>
            <th>Due Date</th>
            <th>Portfolio</th>
            <th className="min-w-[220px]">
              <span className="flex items-center gap-1.5">
                Next Steps
                {/* ⓘ shortcode help tooltip */}
                <span className="relative inline-block">
                  <button
                    className="w-4 h-4 rounded-full bg-gray-400 text-white text-xs font-bold flex items-center justify-center hover:bg-gray-500 focus:outline-none leading-none"
                    onMouseEnter={() => setShowTooltip(true)}
                    onMouseLeave={() => setShowTooltip(false)}
                    onClick={() => setShowTooltip((v) => !v)}
                    tabIndex={-1}
                    aria-label="Shortcode help"
                  >
                    ?
                  </button>
                  {showTooltip && (
                    <div className="absolute right-6 top-0 z-50 w-72 bg-navy text-white text-xs rounded-lg p-3 shadow-2xl border border-navy-light">
                      <p className="font-semibold mb-2 text-white">Shortcode reference:</p>
                      <div className="space-y-1.5">
                        <div className="flex gap-2">
                          <span className="text-brand-orange font-mono font-bold w-16 shrink-0">D</span>
                          <span className="text-gray-300">Hard delete the task permanently</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-brand-orange font-mono font-bold w-16 shrink-0">RCE14</span>
                          <span className="text-gray-300">Mark complete + new task in 14 days</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-brand-orange font-mono font-bold w-16 shrink-0">P30</span>
                          <span className="text-gray-300">Push due date back by 30 days</span>
                        </div>
                      </div>
                      <p className="text-gray-500 mt-2 text-xs">Replace the number with any value you want.</p>
                    </div>
                  )}
                </span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, rowIdx) => (
            <tr key={task.Id} className={rowIdx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>

              {/* Row number */}
              <td className="text-center text-xs text-gray-300 font-mono w-8">{rowIdx + 1}</td>

              {/* Account Name — col 1 */}
              <td
                tabIndex={0}
                onClick={() => setActiveCell({ row: rowIdx, col: 1 })}
                onFocus={() => setActiveCell({ row: rowIdx, col: 1 })}
                className={`${cellBase} cursor-default ${isCellActive(rowIdx, 1) ? cellActive : ""}`}
              >
                <span className="font-medium text-navy text-sm">
                  {task.AccountName ?? <span className="text-gray-400 italic text-sm">No account</span>}
                </span>
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
                    className="inline-flex items-center gap-1 text-brand-orange hover:text-brand-orange-hover text-sm font-medium underline underline-offset-2"
                  >
                    Open ↗
                  </a>
                ) : (
                  <span className="text-gray-300 text-sm">—</span>
                )}
              </td>

              {/* Task Subject — col 3 */}
              <td
                tabIndex={0}
                onClick={() => setActiveCell({ row: rowIdx, col: 3 })}
                onFocus={() => setActiveCell({ row: rowIdx, col: 3 })}
                className={`${cellBase} cursor-default ${isCellActive(rowIdx, 3) ? cellActive : ""}`}
              >
                <span className="text-gray-600 text-sm">{task.Subject}</span>
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
                      className="text-sm text-brand-orange hover:text-brand-orange-hover underline underline-offset-2 font-mono"
                    >
                      {task.ActivityDate}
                    </a>
                  ) : (
                    <span className="text-sm text-gray-500 font-mono">{task.ActivityDate}</span>
                  )
                ) : (
                  <span className="text-gray-300 text-sm">—</span>
                )}
              </td>

              {/* Portfolio match — col 5 */}
              <td
                tabIndex={0}
                onClick={() => setActiveCell({ row: rowIdx, col: 5 })}
                onFocus={() => setActiveCell({ row: rowIdx, col: 5 })}
                className={`${cellBase} ${isCellActive(rowIdx, 5) ? cellActive : ""}`}
              >
                {renderPortfolio(task)}
              </td>

              {/* Next Steps shortcode input — col 6 */}
              <td
                tabIndex={-1}
                onClick={() => focusCell(rowIdx, INTERACTIVE_COL)}
                className={`p-1.5 ${cellBase} ${isCellActive(rowIdx, INTERACTIVE_COL) ? cellActive : ""}`}
              >
                <div className="flex flex-col gap-0.5">
                  <input
                    ref={(el) => {
                      if (el) inputRefs.current.set(task.Id, el);
                      else inputRefs.current.delete(task.Id);
                    }}
                    type="text"
                    value={inputValues.get(task.Id) ?? ""}
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
                    className={`w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange transition-colors ${getInputBorderClass(task.Id)}`}
                  />
                  {renderBadge(task.Id)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
