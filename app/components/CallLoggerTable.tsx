"use client";

import React, { useRef, useState, useCallback } from "react";

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

/** A Granola note matched to this meeting (summary only; transcript on demand). */
export type GranolaRowNote = {
  noteId: string;
  title: string | null;
  summary: string;
  webUrl: string | null;
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
  notes: string; // Granola meeting notes
  /** Fields you've typed in or accepted. A suggestion stops showing once touched. */
  touched?: { callType?: boolean; commentary?: boolean; followUp?: boolean };
};

/** Suggested fields for a row, shown lighter until you edit or accept them. */
export type RowSuggestion = {
  commentary: string | null;
  callType: "C1" | "RCC" | null;
  typeReason: string | null;
  followUpDays: number | null;
  followUpReason: string | null;
};

type SuggestField = "callType" | "commentary" | "followUp";

/** Which suggested fields are still waiting (not typed over, accepted or cleared). */
export function pendingSuggestionFields(entry: CallEntry | undefined, s: RowSuggestion | undefined): SuggestField[] {
  if (!s) return [];
  const touched = entry?.touched ?? {};
  const out: SuggestField[] = [];
  if (s.callType && !touched.callType && !entry?.callType) out.push("callType");
  if (s.commentary && !touched.commentary && !entry?.commentary) out.push("commentary");
  if (s.followUpDays && !touched.followUp && !entry?.followUpDays) out.push("followUp");
  return out;
}

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
  /** Granola notes by meeting eventId. Rows without one stay as they are. */
  granolaNotes?: Map<string, GranolaRowNote>;
  /** Suggested fields by eventId (from Granola notes or pasted notes). */
  suggestions?: Map<string, RowSuggestion>;
  /** Rows whose suggestion is being written right now. */
  suggestionsLoading?: Set<string>;
  onSuggestion?: (eventId: string, suggestion: RowSuggestion) => void;
};

type TranscriptState = { open: boolean; loading: boolean; text?: string; error?: string };

// ── Component ─────────────────────────────────────────────────────────────────

export default function CallLoggerTable({
  meetings,
  entries,
  onEntryChange,
  dismissedIds,
  onDismiss,
  manualMatches,
  onManualMatch,
  granolaNotes,
  suggestions,
  suggestionsLoading,
  onSuggestion,
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

  // Notes panel state — tracks which rows have the notes text area open
  const [notesOpen, setNotesOpen] = useState<Set<string>>(new Set());
  const [suggesting, setSuggesting] = useState<Set<string>>(new Set());
  const [suggestErrors, setSuggestErrors] = useState<Map<string, string>>(new Map());
  const [transcripts, setTranscripts] = useState<Map<string, TranscriptState>>(new Map());

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
        notes: "",
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

  async function suggestFromNotes(meeting: MeetingRow) {
    const entry = getEntry(meeting.eventId);
    if (!entry.notes.trim()) return;
    setSuggesting((prev) => new Set(prev).add(meeting.eventId));
    setSuggestErrors((prev) => { const next = new Map(prev); next.delete(meeting.eventId); return next; });
    try {
      const account = getSelectedMatch(meeting);
      const res = await fetch("/api/calls/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: meeting.eventId,
          meetingTitle: meeting.subject,
          meetingDate: meeting.meetingDate,
          accountId: account?.accountId,
          accountName: account?.accountName,
          // Hand-pasted notes are only used when the row has no Granola note.
          notes: granolaNotes?.has(meeting.eventId) ? undefined : entry.notes,
          force: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Suggestion failed");
      const s = data.suggestion as RowSuggestion;
      // A fresh suggestion shows again in the fields you haven't typed in yet.
      onEntryChange(meeting.eventId, { ...entry, touched: {} });
      onSuggestion?.(meeting.eventId, {
        commentary: s.commentary ?? null,
        callType: s.callType ?? null,
        typeReason: s.typeReason ?? null,
        followUpDays: s.followUpDays ?? null,
        followUpReason: s.followUpReason ?? null,
      });
    } catch (err) {
      setSuggestErrors((prev) => new Map(prev).set(meeting.eventId, err instanceof Error ? err.message : "Suggestion failed"));
    } finally {
      setSuggesting((prev) => { const next = new Set(prev); next.delete(meeting.eventId); return next; });
    }
  }

  function acceptSuggestion(eventId: string, field: SuggestField) {
    const s = suggestions?.get(eventId);
    if (!s) return;
    const prev = getEntry(eventId);
    const touched = { ...(prev.touched ?? {}), [field]: true };
    if (field === "callType" && s.callType) {
      onEntryChange(eventId, { ...prev, callType: s.callType, touched });
      setTypeRawValues((m) => new Map(m).set(eventId, s.callType!));
    } else if (field === "commentary" && s.commentary) {
      onEntryChange(eventId, { ...prev, commentary: s.commentary, touched });
    } else if (field === "followUp" && s.followUpDays) {
      onEntryChange(eventId, { ...prev, followUpDays: s.followUpDays, touched });
      setFollowUpRawValues((m) => new Map(m).set(eventId, `RCE${s.followUpDays}`));
    }
  }

  function renderSuggestedMarker(eventId: string, field: SuggestField, reason: string | null) {
    return (
      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          acceptSuggestion(eventId, field);
        }}
        title={reason ? `${reason}. Click to accept.` : "Click to accept this suggestion"}
        className="self-start inline-flex items-center gap-1 rounded bg-sky-50 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-sky-700 hover:bg-sky-100"
      >
        Suggested <span aria-hidden="true">·</span> <span className="normal-case tracking-normal">Accept</span>
      </button>
    );
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
    onEntryChange(eventId, { ...prev, eventId, callType: valid as "" | "C1" | "RCC", touched: { ...(prev.touched ?? {}), callType: true } });
  }

  function handleCommentaryChange(eventId: string, value: string) {
    const prev = getEntry(eventId);
    onEntryChange(eventId, { ...prev, eventId, commentary: value, touched: { ...(prev.touched ?? {}), commentary: true } });
  }

  function handleFollowUpChange(eventId: string, value: string) {
    const prev = getEntry(eventId);
    const days = parseFollowUp(value);
    onEntryChange(eventId, { ...prev, eventId, followUpDays: days, touched: { ...(prev.touched ?? {}), followUp: true } });
  }

  function handleAccountSelect(eventId: string, idx: number) {
    const prev = getEntry(eventId);
    onEntryChange(eventId, { ...prev, eventId, selectedAccountIdx: idx });
  }

  function handleNotesChange(eventId: string, value: string) {
    const prev = getEntry(eventId);
    onEntryChange(eventId, { ...prev, eventId, notes: value });
  }

  async function toggleTranscript(eventId: string, noteId: string) {
    const current = transcripts.get(eventId);
    if (current?.open) {
      setTranscripts((prev) => new Map(prev).set(eventId, { ...current, open: false }));
      return;
    }
    if (current?.text !== undefined) {
      setTranscripts((prev) => new Map(prev).set(eventId, { ...current, open: true }));
      return;
    }
    setTranscripts((prev) => new Map(prev).set(eventId, { open: true, loading: true }));
    try {
      const res = await fetch(`/api/granola/notes/${encodeURIComponent(noteId)}/transcript`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't load the transcript");
      setTranscripts((prev) => new Map(prev).set(eventId, { open: true, loading: false, text: data.transcript ?? "" }));
    } catch (err) {
      setTranscripts((prev) =>
        new Map(prev).set(eventId, {
          open: true,
          loading: false,
          error: err instanceof Error ? err.message : "Couldn't load the transcript",
        }),
      );
    }
  }

  function toggleNotes(eventId: string) {
    setNotesOpen((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
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
            <th className="min-w-[180px]">Meeting Title</th>
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
            const suggestion = hasMatch ? suggestions?.get(meeting.eventId) : undefined;
            const pending = new Set(pendingSuggestionFields(entry, suggestion));
            const typePending = pending.has("callType");
            const commentaryPending = pending.has("commentary");
            const followUpPending = pending.has("followUp");
            const suggestionLoading = hasMatch && suggestionsLoading?.has(meeting.eventId);
            const typeRaw = typePending
              ? suggestion!.callType!
              : typeRawValues.get(meeting.eventId) ?? (entry.callType || "");
            const followUpRaw = followUpPending
              ? `RCE${suggestion!.followUpDays}`
              : followUpRawValues.get(meeting.eventId) ?? (entry.followUpDays ? `RCE${entry.followUpDays}` : "");
            const suggestedClass = "border-dashed border-sky-300 bg-white text-gray-400 italic";

            // Row background: gray for already-logged, alternating for normal
            const rowBg = meeting.alreadyLogged
              ? "bg-amber-50/60"
              : rowIdx % 2 === 0
                ? "bg-white"
                : "bg-gray-50/50";

            return (
              <React.Fragment key={meeting.eventId}>
              <tr
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

                {/* Meeting Title + Notes button — col 1 */}
                <td
                  tabIndex={0}
                  onClick={() => setActiveCell({ row: rowIdx, col: 1 })}
                  onFocus={() => setActiveCell({ row: rowIdx, col: 1 })}
                  className={`${cellBase} cursor-default ${isCellActive(rowIdx, 1) ? cellActive : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`font-medium text-sm ${meeting.alreadyLogged ? "text-gray-400" : "text-navy"}`}>
                      {meeting.subject}
                    </span>
                    {hasMatch && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleNotes(meeting.eventId);
                        }}
                        className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-colors ${
                          notesOpen.has(meeting.eventId)
                            ? "bg-brand-orange text-white"
                            : entry.notes
                              ? "bg-orange-100 text-brand-orange border border-orange-300"
                              : "bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                        }`}
                        title={
                          notesOpen.has(meeting.eventId)
                            ? "Hide notes"
                            : granolaNotes?.has(meeting.eventId)
                              ? "Granola notes attached"
                              : entry.notes
                                ? "Edit notes"
                                : "Add Granola notes"
                        }
                        tabIndex={-1}
                      >
                        {granolaNotes?.has(meeting.eventId) ? "✎ Granola" : entry.notes ? "✎ Notes" : "+ Notes"}
                      </button>
                    )}
                  </div>
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
                          if (typePending) acceptSuggestion(meeting.eventId, "callType");
                          focusCell(rowIdx, 6); // move to commentary
                        }
                      }}
                      title={typePending ? suggestion?.typeReason ?? undefined : undefined}
                      className={`w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange transition-colors ${
                        !hasMatch
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : typePending
                            ? suggestedClass
                            : getTypeBorderClass(entry.callType)
                      }`}
                    />
                    {typePending
                      ? renderSuggestedMarker(meeting.eventId, "callType", suggestion?.typeReason ?? null)
                      : renderTypeBadge(entry.callType)}
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
                    value={commentaryPending ? suggestion!.commentary! : entry.commentary}
                    placeholder={
                      !hasMatch ? "—" : suggestionLoading ? "Writing a suggestion from Granola…" : "e.g. 10M, young, reconnect"
                    }
                    disabled={!hasMatch}
                    onChange={(e) =>
                      handleCommentaryChange(meeting.eventId, e.target.value)
                    }
                    onFocus={() => setActiveCell({ row: rowIdx, col: 6 })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (commentaryPending) acceptSuggestion(meeting.eventId, "commentary");
                        focusCell(rowIdx, 7); // move to follow-up
                      }
                    }}
                    title={commentaryPending ? suggestion!.commentary! : undefined}
                    className={`w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange transition-colors ${
                      !hasMatch
                        ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200"
                        : commentaryPending
                          ? suggestedClass
                          : "border-gray-200 bg-white"
                    }`}
                  />
                  {commentaryPending ? (
                    <div className="mt-0.5 flex">{renderSuggestedMarker(meeting.eventId, "commentary", null)}</div>
                  ) : null}
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
                          if (followUpPending) acceptSuggestion(meeting.eventId, "followUp");
                          if (rowIdx < meetings.length - 1)
                            focusCell(rowIdx + 1, 5); // next row, type col
                        }
                      }}
                      title={
                        suggestion?.followUpReason &&
                        (followUpPending || entry.followUpDays === suggestion.followUpDays)
                          ? suggestion.followUpReason
                          : undefined
                      }
                      className={`w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange transition-colors ${
                        !hasMatch
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200"
                          : followUpPending
                            ? suggestedClass
                            : entry.followUpDays
                              ? "border-purple-400 bg-purple-50"
                              : "border-gray-200 bg-white"
                      }`}
                    />
                    {followUpPending
                      ? renderSuggestedMarker(meeting.eventId, "followUp", suggestion?.followUpReason ?? null)
                      : renderFollowUpBadge(entry.followUpDays)}
                  </div>
                </td>

              </tr>
              {/* Expandable notes row */}
              {notesOpen.has(meeting.eventId) && hasMatch && (
                <tr className={rowBg}>
                  <td />
                  <td colSpan={7} className="pb-3 pt-0 px-2">
                    <div className="border border-orange-200 rounded-lg bg-orange-50/50 p-3">
                      {(() => {
                        const granola = granolaNotes?.get(meeting.eventId);
                        if (!granola) return null;
                        const t = transcripts.get(meeting.eventId);
                        return (
                          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            <span className="rounded bg-white px-1.5 py-0.5 font-semibold text-navy border border-orange-200">
                              From Granola
                            </span>
                            {granola.webUrl ? (
                              <a
                                href={granola.webUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-brand-orange underline underline-offset-2"
                              >
                                Open in Granola ↗
                              </a>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void toggleTranscript(meeting.eventId, granola.noteId)}
                              className="font-medium text-navy underline underline-offset-2"
                              aria-expanded={Boolean(t?.open)}
                            >
                              {t?.open ? "Hide transcript" : "Show transcript"}
                            </button>
                          </div>
                        );
                      })()}
                      {(() => {
                        const t = transcripts.get(meeting.eventId);
                        if (!t?.open) return null;
                        return (
                          <div className="mb-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-white px-3 py-2 text-xs leading-5 text-gray-700">
                            {t.loading
                              ? "Loading transcript from Granola…"
                              : t.error
                                ? <span className="text-red-600">{t.error}</span>
                                : t.text || "Granola has no transcript for this call."}
                          </div>
                        );
                      })()}
                      <label className="text-xs font-medium text-gray-500 mb-1.5 block">
                        Granola Meeting Notes — will be saved as &quot;{entry.callType || "C1/RCC"} Notes&quot; in Salesforce
                      </label>
                      <textarea
                        value={entry.notes}
                        onChange={(e) => handleNotesChange(meeting.eventId, e.target.value)}
                        placeholder="Paste your Granola meeting notes here..."
                        rows={6}
                        className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange bg-white resize-y"
                      />
                      {entry.notes && (
                        <div className="flex items-center justify-between gap-3 mt-1.5">
                          <button
                            type="button"
                            onClick={() => suggestFromNotes(meeting)}
                            disabled={suggesting.has(meeting.eventId)}
                            className="rounded-md bg-navy px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                          >
                            {suggesting.has(meeting.eventId)
                              ? "Reviewing notes…"
                              : granolaNotes?.has(meeting.eventId)
                                ? "Suggest again"
                                : "Suggest call log"}
                          </button>
                          <span className="text-xs text-gray-400">
                            {entry.notes.length} characters
                          </span>
                        </div>
                      )}
                      {suggestErrors.get(meeting.eventId) && (
                        <p className="mt-1 text-xs text-red-600">{suggestErrors.get(meeting.eventId)}</p>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
