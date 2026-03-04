"use client";

import { useRef, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MeetingRow = {
  eventId: string;
  subject: string;
  meetingDate: string; // "2026-03-05"
  startTime: string;
  match: {
    accountId: string;
    accountName: string;
    accountUrl: string;
  } | null;
  allMatches: Array<{
    accountId: string;
    accountName: string;
    accountUrl: string;
    domain: string;
  }>;
  externalDomains: string[];
  alreadyLogged: boolean;
};

export type ManualMatch = {
  accountId: string;
  accountName: string;
  accountUrl: string;
};

export type CallEntry = {
  eventId: string;
  callType: "C1" | "RCC" | "";
  commentary: string;
  followUpDays: number | null;
  selectedAccountIdx: number; // index into allMatches
};

// ── Shortcode parser for follow-up column ─────────────────────────────────────

function parseFollowUp(text: string): number | null {
  const t = text.trim().toUpperCase();
  const rce = t.match(/^RCE(\d+)$/);
  if (rce) return parseInt(rce[1]);
  return null;
}

// ── Column indexes ────────────────────────────────────────────────────────────
// 0=row#, 1=meeting-title, 2=account, 3=sf-link, 4=date, 5=type, 6=commentary, 7=follow-up
const FIRST_COL = 1;
const LAST_COL = 7;
const FIRST_INPUT_COL = 5;

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  meetings: MeetingRow[];
  entries: Map<string, CallEntry>;
  onEntryChange: (eventId: string, entry: CallEntry) => void;
  dismissedIds: Set<string>;
  onDismiss: (eventId: string) => void;
  manualMatches: Map<string, ManualMatch>;
  onManualMatch: (eventId: string, match: ManualMatch) => void;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function CallLoggerTable({
  meetings,
  entries,
  onEntryChange,
  dismissedIds,
  onDismiss,
  manualMatches,
  onManualMatch,
}: Props) {
  const [activeCell, setActiveCell] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement | HTMLSelectElement>>(
    new Map()
  );
  const [showTooltip, setShowTooltip] = useState(false);

  // Raw input values — these track what the user has typed (before parsing)
  const [typeRawValues, setTypeRawValues] = useState<Map<string, string>>(new Map());
  const [followUpRawValues, setFollowUpRawValues] = useState<Map<string, string>>(new Map());

  // Account search state
  const [searchInputs, setSearchInputs] = useState<Map<string, string>>(new Map());
  const [searchResults, setSearchResults] = useState<Map<string, Array<{ accountId: string; accountName: string; accountUrl: string }>>>(new Map());
  const [searchLoading, setSearchLoading] = useState<Set<string>>(new Set());

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function getEntry(eventId: string): CallEntry {
    return (
      entries.get(eventId) ?? {
        eventId,
        callType: "",
        commentary: "",
        followUpDays: null,
        selectedAccountIdx: 0,
      }
    );
  }

  function getSelectedMatch(meeting: MeetingRow) {
    // Check for manual match first
    const manual = manualMatches.get(meeting.eventId);
    if (manual) return manual;
    const entry = getEntry(meeting.eventId);
    if (meeting.allMatches.length === 0) return null;
    return meeting.allMatches[entry.selectedAccountIdx] ?? meeting.allMatches[0];
  }

  function hasAccountMatch(meeting: MeetingRow): boolean {
    return manualMatches.has(meeting.eventId) || meeting.allMatches.length > 0;
  }

  function focusCell(row: number, col: number) {
    setActiveCell({ row, col });
    if (col >= FIRST_INPUT_COL && row >= 0 && row < meetings.length) {
      const key = `${meetings[row].eventId}-${col}`;
      const ref = inputRefs.current.get(key);
      if (ref) setTimeout(() => ref.focus(), 0);
    }
  }

  // ── Keyboard navigation ────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableElement>) => {
      if (!activeCell) return;
      const { row, col } = activeCell;

      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        if (col < LAST_COL) focusCell(row, col + 1);
        else if (row < meetings.length - 1) focusCell(row + 1, FIRST_COL);
      } else if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        if (col > FIRST_COL) focusCell(row, col - 1);
        else if (row > 0) focusCell(row - 1, LAST_COL);
      } else if (e.key === "ArrowDown") {
        if (col < FIRST_INPUT_COL) {
          e.preventDefault();
          if (row < meetings.length - 1) focusCell(row + 1, col);
        }
      } else if (e.key === "ArrowUp") {
        if (col < FIRST_INPUT_COL) {
          e.preventDefault();
          if (row > 0) focusCell(row - 1, col);
        }
      } else if (e.key === "Enter" && !e.shiftKey && col < FIRST_INPUT_COL) {
        e.preventDefault();
        if (row < meetings.length - 1) focusCell(row + 1, col);
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        if (row > 0) focusCell(row - 1, col);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeCell, meetings]
  );

  // ── Input handlers ──────────────────────────────────────────────────────────

  function handleTypeChange(eventId: string, value: string) {
    const upper = value.trim().toUpperCase();
    const valid = upper === "C1" || upper === "RCC" ? upper : "";
    const prev = getEntry(eventId);
    onEntryChange(eventId, { ...prev, eventId, callType: valid as "" | "C1" | "RCC" });
  }

  function handleCommentaryChange(eventId: string, value: string) {
    const prev = getEntry(eventId);
    onEntryChange(eventId, { ...prev, eventId, commentary: value });
  }

  function handleFollowUpChange(eventId: string, value: string) {
    const prev = getEntry(eventId);
    const days = parseFollowUp(value);
    onEntryChange(eventId, { ...prev, eventId, followUpDays: days });
  }

  function handleAccountSelect(eventId: string, idx: number) {
    const prev = getEntry(eventId);
    onEntryChange(eventId, { ...prev, eventId, selectedAccountIdx: idx });
  }

  // ── Account search handler ────────────────────────────────────────────────

  async function handleAccountSearch(eventId: string) {
    const query = searchInputs.get(eventId)?.trim();
    if (!query || query.length < 2) return;

    setSearchLoading((prev) => new Set(prev).add(eventId));
    setSearchResults((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });

    try {
      const res = await fetch(`/api/salesforce/search-accounts?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults((prev) => new Map(prev).set(eventId, data.accounts ?? []));
      }
    } catch {
      // fail silently
    } finally {
      setSearchLoading((prev) => {
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
    }
  }

  function handleSelectSearchResult(eventId: string, account: { accountId: string; accountName: string; accountUrl: string }) {
    onManualMatch(eventId, account);
    // Clear search state for this row
    setSearchResults((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
    setSearchInputs((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
  }

  // ── Cell styling ────────────────────────────────────────────────────────────

  function isCellActive(row: number, col: number) {
    return activeCell?.row === row && activeCell?.col === col;
  }

  const cellBase = "outline-none";
  const cellActive = "ring-2 ring-inset ring-blue-400";

  function getTypeBorderClass(callType: string) {
    if (callType === "C1") return "border-green-400 bg-green-50";
    if (callType === "RCC") return "border-blue-400 bg-blue-50";
    return "border-gray-200 bg-white";
  }

  function renderTypeBadge(callType: string) {
    if (callType === "C1")
      return (
        <span className="text-xs text-green-600 font-medium">→ First Call</span>
      );
    if (callType === "RCC")
      return (
        <span className="text-xs text-blue-600 font-medium">
          → Reconnect Call
        </span>
      );
    return null;
  }

  function renderFollowUpBadge(days: number | null) {
    if (days && days > 0)
      return (
        <span className="text-xs text-purple-600 font-medium">
          → Follow-up in {days}d
        </span>
      );
    return null;
  }

  // ── Empty state ─────────────────────────────────────────────────────────────

  if (meetings.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <div className="text-5xl mb-4">📅</div>
        <p className="font-medium">No external meetings found for this week</p>
        <p className="text-sm mt-1">
          All meetings were internal or had no attendees to match
        </p>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

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
            <th>Meeting Title</th>
            <th>Account</th>
            <th>Salesforce</th>
            <th>Date</th>
            <th className="min-w-[100px]">
              <span className="flex items-center gap-1.5">
                Type
                <span className="relative inline-block">
                  <button
                    className="w-4 h-4 rounded-full bg-gray-400 text-white text-xs font-bold flex items-center justify-center hover:bg-gray-500 focus:outline-none leading-none"
                    onMouseEnter={() => setShowTooltip(true)}
                    onMouseLeave={() => setShowTooltip(false)}
                    onClick={() => setShowTooltip((v) => !v)}
                    tabIndex={-1}
                    aria-label="Type help"
                  >
                    ?
                  </button>
                  {showTooltip && (
                    <div className="absolute right-6 top-0 z-50 w-64 bg-navy text-white text-xs rounded-lg p-3 shadow-2xl border border-navy-light">
                      <p className="font-semibold mb-2 text-white">
                        Type reference:
                      </p>
                      <div className="space-y-1.5">
                        <div className="flex gap-2">
                          <span className="text-brand-orange font-mono font-bold w-10 shrink-0">
                            C1
                          </span>
                          <span className="text-gray-300">
                            First Call — logs a completed C1 task
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-brand-orange font-mono font-bold w-10 shrink-0">
                            RCC
                          </span>
                          <span className="text-gray-300">
                            Reconnect Call — logs a completed RCC task
                          </span>
                        </div>
                      </div>
                      <p className="text-gray-500 mt-2 text-xs">
                        Leave blank to skip a meeting.
                      </p>
                    </div>
                  )}
                </span>
              </span>
            </th>
            <th className="min-w-[200px]">Commentary</th>
            <th className="min-w-[120px]">
              <span className="flex items-center gap-1.5">
                Follow-up
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((meeting, rowIdx) => {
            const isDismissed = dismissedIds.has(meeting.eventId);
            if (isDismissed) return null;

            const entry = getEntry(meeting.eventId);
            const selectedMatch = getSelectedMatch(meeting);
            const hasMatch = hasAccountMatch(meeting);
            const isManualMatch = manualMatches.has(meeting.eventId);
            const typeRaw = typeRawValues.get(meeting.eventId) ?? (entry.callType || "");
            const followUpRaw = followUpRawValues.get(meeting.eventId) ?? (entry.followUpDays ? `RCE${entry.followUpDays}` : "");

            // Row background: gray for already-logged, alternating for normal
            const rowBg = meeting.alreadyLogged
              ? "bg-amber-50/60"
              : rowIdx % 2 === 0
                ? "bg-white"
                : "bg-gray-50/50";

            return (
              <tr
                key={meeting.eventId}
                className={rowBg}
              >
                {/* Row number + dismiss button */}
                <td className="text-center w-8 relative group">
                  <span className="text-xs text-gray-300 font-mono group-hover:hidden">
                    {rowIdx + 1}
                  </span>
                  <button
                    onClick={() => onDismiss(meeting.eventId)}
                    className="hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-500 hover:bg-red-500 hover:text-white transition-colors mx-auto text-xs font-bold leading-none"
                    title="Dismiss this meeting"
                    tabIndex={-1}
                  >
                    ×
                  </button>
                </td>

                {/* Meeting Title — col 1 */}
                <td
                  tabIndex={0}
                  onClick={() => setActiveCell({ row: rowIdx, col: 1 })}
                  onFocus={() => setActiveCell({ row: rowIdx, col: 1 })}
                  className={`${cellBase} cursor-default ${isCellActive(rowIdx, 1) ? cellActive : ""}`}
                >
                  <span className={`font-medium text-sm ${meeting.alreadyLogged ? "text-gray-400" : "text-navy"}`}>
                    {meeting.subject}
                  </span>
                </td>

                {/* Account Name — col 2 */}
                <td
                  tabIndex={0}
                  onClick={() => setActiveCell({ row: rowIdx, col: 2 })}
                  onFocus={() => setActiveCell({ row: rowIdx, col: 2 })}
                  className={`${cellBase} cursor-default ${isCellActive(rowIdx, 2) ? cellActive : ""}`}
                >
                  {/* Manual match selected — show linked account */}
                  {isManualMatch ? (
                    <span className={`font-medium text-sm ${meeting.alreadyLogged ? "text-gray-400" : "text-navy"}`}>
                      {manualMatches.get(meeting.eventId)!.accountName}
                      {meeting.alreadyLogged ? (
                        <span className="block text-xs text-amber-500 font-medium mt-0.5">Likely already logged</span>
                      ) : (
                        <span className="block text-xs text-green-500 mt-0.5">Manually linked</span>
                      )}
                    </span>
                  ) : meeting.allMatches.length > 1 ? (
                    <select
                      value={entry.selectedAccountIdx}
                      onChange={(e) =>
                        handleAccountSelect(
                          meeting.eventId,
                          parseInt(e.target.value)
                        )
                      }
                      className="text-sm font-medium text-navy border border-gray-200 rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-orange"
                    >
                      {meeting.allMatches.map((m, i) => (
                        <option key={m.accountId} value={i}>
                          {m.accountName}
                        </option>
                      ))}
                    </select>
                  ) : hasMatch && !isManualMatch ? (
                    <div>
                      <span className={`font-medium text-sm ${meeting.alreadyLogged ? "text-gray-400" : "text-navy"}`}>
                        {selectedMatch?.accountName}
                      </span>
                      {meeting.alreadyLogged && (
                        <span className="block text-xs text-amber-500 font-medium mt-0.5">
                          Likely already logged
                        </span>
                      )}
                    </div>
                  ) : (
                    /* No match — show search UI */
                    <div className="space-y-1">
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={searchInputs.get(meeting.eventId) ?? ""}
                          placeholder={meeting.externalDomains.length > 0 ? meeting.externalDomains[0].split(".")[0] : "Search account..."}
                          onChange={(e) => setSearchInputs((prev) => new Map(prev).set(meeting.eventId, e.target.value))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAccountSearch(meeting.eventId);
                            }
                          }}
                          className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange"
                        />
                        <button
                          onClick={() => handleAccountSearch(meeting.eventId)}
                          disabled={searchLoading.has(meeting.eventId)}
                          className="shrink-0 bg-navy hover:bg-navy/80 disabled:opacity-50 text-white text-xs font-medium px-2 py-1 rounded transition-colors"
                        >
                          {searchLoading.has(meeting.eventId) ? "..." : "Search"}
                        </button>
                      </div>
                      {meeting.externalDomains.length > 0 && !searchInputs.has(meeting.eventId) && (
                        <span className="text-xs text-gray-300">
                          {meeting.externalDomains.join(", ")}
                        </span>
                      )}
                      {/* Search results dropdown */}
                      {searchResults.has(meeting.eventId) && (
                        <div className="border border-gray-200 rounded bg-white shadow-lg max-h-32 overflow-y-auto">
                          {(searchResults.get(meeting.eventId) ?? []).length === 0 ? (
                            <div className="px-2 py-1.5 text-xs text-gray-400 italic">No accounts found</div>
                          ) : (
                            (searchResults.get(meeting.eventId) ?? []).map((account) => (
                              <button
                                key={account.accountId}
                                onClick={() => handleSelectSearchResult(meeting.eventId, account)}
                                className="w-full text-left px-2 py-1.5 text-sm hover:bg-blue-50 hover:text-blue-700 border-b border-gray-100 last:border-0 transition-colors"
                              >
                                {account.accountName}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </td>

                {/* Salesforce link — col 3 */}
                <td
                  tabIndex={0}
                  onClick={() => setActiveCell({ row: rowIdx, col: 3 })}
                  onFocus={() => setActiveCell({ row: rowIdx, col: 3 })}
                  className={`${cellBase} ${isCellActive(rowIdx, 3) ? cellActive : ""}`}
                >
                  {hasMatch && selectedMatch ? (
                    <a
                      href={selectedMatch.accountUrl}
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

                {/* Meeting Date — col 4 */}
                <td
                  tabIndex={0}
                  onClick={() => setActiveCell({ row: rowIdx, col: 4 })}
                  onFocus={() => setActiveCell({ row: rowIdx, col: 4 })}
                  className={`${cellBase} ${isCellActive(rowIdx, 4) ? cellActive : ""}`}
                >
                  <span className={`text-sm font-mono ${meeting.alreadyLogged ? "text-gray-400" : "text-gray-500"}`}>
                    {meeting.meetingDate}
                  </span>
                </td>

                {/* Type — col 5 (C1 / RCC / blank) */}
                <td
                  tabIndex={-1}
                  onClick={() => focusCell(rowIdx, 5)}
                  className={`p-1.5 ${cellBase} ${isCellActive(rowIdx, 5) ? cellActive : ""}`}
                >
                  <div className="flex flex-col gap-0.5">
                    <input
                      ref={(el) => {
                        const key = `${meeting.eventId}-5`;
                        if (el) inputRefs.current.set(key, el);
                        else inputRefs.current.delete(key);
                      }}
                      type="text"
                      value={typeRaw}
                      placeholder={hasMatch ? "C1 / RCC" : "—"}
                      disabled={!hasMatch}
                      onChange={(e) => {
                        setTypeRawValues((prev) => new Map(prev).set(meeting.eventId, e.target.value));
                        handleTypeChange(meeting.eventId, e.target.value);
                      }}
                      onFocus={() =>
                        setActiveCell({ row: rowIdx, col: 5 })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          focusCell(rowIdx, 6); // move to commentary
                        }
                      }}
                      className={`w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange transition-colors ${
                        !hasMatch
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : getTypeBorderClass(entry.callType)
                      }`}
                    />
                    {renderTypeBadge(entry.callType)}
                  </div>
                </td>

                {/* Commentary — col 6 */}
                <td
                  tabIndex={-1}
                  onClick={() => focusCell(rowIdx, 6)}
                  className={`p-1.5 ${cellBase} ${isCellActive(rowIdx, 6) ? cellActive : ""}`}
                >
                  <input
                    ref={(el) => {
                      const key = `${meeting.eventId}-6`;
                      if (el) inputRefs.current.set(key, el);
                      else inputRefs.current.delete(key);
                    }}
                    type="text"
                    value={entry.commentary}
                    placeholder={hasMatch ? "e.g. 10M, young, reconnect" : "—"}
                    disabled={!hasMatch}
                    onChange={(e) =>
                      handleCommentaryChange(meeting.eventId, e.target.value)
                    }
                    onFocus={() => setActiveCell({ row: rowIdx, col: 6 })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        focusCell(rowIdx, 7); // move to follow-up
                      }
                    }}
                    className={`w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange transition-colors ${
                      !hasMatch
                        ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200"
                        : "border-gray-200 bg-white"
                    }`}
                  />
                </td>

                {/* Follow-up — col 7 */}
                <td
                  tabIndex={-1}
                  onClick={() => focusCell(rowIdx, 7)}
                  className={`p-1.5 ${cellBase} ${isCellActive(rowIdx, 7) ? cellActive : ""}`}
                >
                  <div className="flex flex-col gap-0.5">
                    <input
                      ref={(el) => {
                        const key = `${meeting.eventId}-7`;
                        if (el) inputRefs.current.set(key, el);
                        else inputRefs.current.delete(key);
                      }}
                      type="text"
                      value={followUpRaw}
                      placeholder={hasMatch ? "RCE14" : "—"}
                      disabled={!hasMatch}
                      onChange={(e) => {
                        setFollowUpRawValues((prev) => new Map(prev).set(meeting.eventId, e.target.value));
                        handleFollowUpChange(meeting.eventId, e.target.value);
                      }}
                      onFocus={() =>
                        setActiveCell({ row: rowIdx, col: 7 })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (rowIdx < meetings.length - 1)
                            focusCell(rowIdx + 1, 5); // next row, type col
                        }
                      }}
                      className={`w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange transition-colors ${
                        !hasMatch
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200"
                          : entry.followUpDays
                            ? "border-purple-400 bg-purple-50"
                            : "border-gray-200 bg-white"
                      }`}
                    />
                    {renderFollowUpBadge(entry.followUpDays)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
