// Sync Granola notes into the Call Logger for one week.
//
// 1. Read the week's calendar (Outlook, read-only) and keep the Call Logger
//    rows: meetings with at least one external attendee.
// 2. List Granola notes created around that week. Notes already stored with
//    the same Granola "updated" time are skipped (dedupe on the note id).
// 3. Read each new or changed note and match it to a row (lib/granola-match).
// 4. Store ONLY matched notes. Internal-only and unmatched notes are dropped
//    in memory and never written anywhere.
//
// Server-only. Nothing is written to Granola, Outlook or Salesforce.

import { addDays, format, parseISO } from "date-fns";
import { getSupabaseAdmin } from "./supabase";
import { fetchCalendarEvents } from "./microsoft";
import { GranolaError, getGranolaNote, isGranolaConfigured, listGranolaNotes, type GranolaNote } from "./granola";
import { isInternalOnlyNote, matchNotesToMeetings } from "./granola-match";
import { externalMeetingsFromEvents, toMatchable, type ExternalMeeting } from "./call-logger-meetings";
import { granolaTableError } from "./granola-store";

export type GranolaSyncResult = {
  weekStart: string;
  weekEnd: string;
  meetings: number; // Call Logger rows that week
  notesSeen: number; // Granola notes created around that week
  unchanged: number; // already stored, same version
  matched: number; // new or updated notes stored now
  skippedInternal: number;
  unmatched: number;
  /** Newly stored or updated rows, for writing suggestions afterwards. */
  stored: Array<{ eventId: string; noteId: string; meetingDate: string; subject: string; domains: string[] }>;
};

export type GranolaSyncState = {
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: Omit<GranolaSyncResult, "stored"> | null;
  trigger: "button" | "schedule" | null;
};

const STATE_KEY = "granola_sync_state";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAUSE_MS = 220; // stay under Granola's 5 requests/second

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StoredVersion = { granola_note_id: string; note_updated_at: string | null; event_id: string };

async function storedVersions(noteIds: string[]): Promise<Map<string, StoredVersion>> {
  if (noteIds.length === 0) return new Map();
  const { data, error } = await getSupabaseAdmin()
    .from("granola_notes")
    .select("granola_note_id, note_updated_at, event_id")
    .in("granola_note_id", noteIds);
  if (error) throw granolaTableError(error.message);
  return new Map(((data ?? []) as StoredVersion[]).map((r) => [r.granola_note_id, r]));
}

async function storeMatch(meeting: ExternalMeeting, note: GranolaNote, matchedBy: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  // One note per meeting: if a different note was stored for this meeting
  // before (e.g. the call was re-recorded), this one replaces it.
  const { error: clearError } = await supabase
    .from("granola_notes")
    .delete()
    .eq("event_id", meeting.event.id)
    .neq("granola_note_id", note.id);
  if (clearError) throw granolaTableError(clearError.message);
  const { error } = await supabase.from("granola_notes").upsert(
    {
      granola_note_id: note.id,
      event_id: meeting.event.id,
      meeting_date: meeting.meetingDate,
      meeting_start: meeting.startUtc,
      title: note.title ?? note.calendar_event?.event_title ?? meeting.event.subject,
      summary: (note.summary_markdown ?? note.summary_text ?? "").trim(),
      web_url: note.web_url ?? null,
      matched_by: matchedBy,
      note_updated_at: note.updated_at,
      synced_at: new Date().toISOString(),
    },
    { onConflict: "granola_note_id" },
  );
  if (error) throw granolaTableError(error.message);
}

export async function syncGranolaWeek(weekStart: string, weekEnd: string): Promise<GranolaSyncResult> {
  if (!ISO_DATE.test(weekStart) || !ISO_DATE.test(weekEnd)) throw new Error("Invalid week");
  if (!isGranolaConfigured()) {
    throw new GranolaError(
      "Granola isn't set up yet: add GRANOLA_API_KEY in Vercel (and .env.local).",
      null,
      "NOT_CONFIGURED",
    );
  }

  const meetings = externalMeetingsFromEvents(await fetchCalendarEvents(weekStart, weekEnd));
  const result: GranolaSyncResult = {
    weekStart,
    weekEnd,
    meetings: meetings.length,
    notesSeen: 0,
    unchanged: 0,
    matched: 0,
    skippedInternal: 0,
    unmatched: 0,
    stored: [],
  };
  if (meetings.length === 0) return result;

  // Notes are created when the call starts; a day either side covers time
  // zones and calls recorded a little early or late.
  const summaries = await listGranolaNotes({
    createdAfter: format(addDays(parseISO(weekStart), -1), "yyyy-MM-dd"),
    createdBefore: format(addDays(parseISO(weekEnd), 2), "yyyy-MM-dd"),
  });
  result.notesSeen = summaries.length;

  const known = await storedVersions(summaries.map((s) => s.id));
  // Meetings whose stored note is already up to date keep it.
  const settledEvents = new Set<string>();
  const toRead = summaries.filter((s) => {
    const stored = known.get(s.id);
    if (stored && stored.note_updated_at && Date.parse(stored.note_updated_at) === Date.parse(s.updated_at)) {
      result.unchanged++;
      settledEvents.add(stored.event_id);
      return false;
    }
    return true;
  });

  const notes: GranolaNote[] = [];
  for (const summary of toRead) {
    const note = await getGranolaNote(summary.id);
    if (isInternalOnlyNote(note)) {
      result.skippedInternal++;
      continue; // dropped: never stored
    }
    notes.push(note);
    await pause(PAUSE_MS);
  }

  const open = meetings.filter((m) => !settledEvents.has(m.event.id));
  const byId = new Map(open.map((m) => [m.event.id, m]));
  const matches = matchNotesToMeetings(open.map(toMatchable), notes);
  result.unmatched = notes.length - matches.length;

  for (const match of matches) {
    const meeting = byId.get(match.eventId)!;
    await storeMatch(meeting, match.note, match.matchedBy);
    result.matched++;
    result.stored.push({
      eventId: meeting.event.id,
      noteId: match.note.id,
      meetingDate: meeting.meetingDate,
      subject: meeting.event.subject,
      domains: meeting.externalDomains,
    });
  }
  return result;
}

// ── Last sync time and error, shown on the Call Logger ──────────────────────

export async function readSyncState(): Promise<GranolaSyncState> {
  const empty: GranolaSyncState = { lastSyncAt: null, lastSuccessAt: null, lastError: null, lastResult: null, trigger: null };
  const { data, error } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", STATE_KEY).maybeSingle();
  if (error || !data) return empty;
  return { ...empty, ...(data.value as Partial<GranolaSyncState>) };
}

async function writeSyncState(state: GranolaSyncState): Promise<void> {
  await getSupabaseAdmin()
    .from("app_settings")
    .upsert({ key: STATE_KEY, value: state }, { onConflict: "key" });
}

/** Plain-words version of a sync failure. */
export function friendlySyncError(err: unknown): string {
  if (err instanceof GranolaError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (message === "MS_NOT_CONNECTED") return "Outlook isn't connected, so the calendar couldn't be read. Connect Outlook and sync again.";
  if (message === "OUTLOOK_RECONNECT_REQUIRED") return "Outlook needs to be reconnected before Granola can sync.";
  if (/Microsoft Graph API failed/i.test(message)) return "Outlook didn't answer, so the calendar couldn't be read. Try again in a minute.";
  return message || "Granola sync failed.";
}

/** Sync several weeks and record the outcome for the Call Logger to show. */
export async function runGranolaSync(
  weeks: Array<{ start: string; end: string }>,
  trigger: "button" | "schedule",
): Promise<{ results: GranolaSyncResult[]; state: GranolaSyncState }> {
  const previous = await readSyncState().catch(() => null);
  const now = new Date().toISOString();
  const results: GranolaSyncResult[] = [];
  try {
    for (const week of weeks) results.push(await syncGranolaWeek(week.start, week.end));
    const total = results.reduce(
      (acc, r) => ({
        weekStart: acc.weekStart || r.weekStart,
        weekEnd: r.weekEnd,
        meetings: acc.meetings + r.meetings,
        notesSeen: acc.notesSeen + r.notesSeen,
        unchanged: acc.unchanged + r.unchanged,
        matched: acc.matched + r.matched,
        skippedInternal: acc.skippedInternal + r.skippedInternal,
        unmatched: acc.unmatched + r.unmatched,
      }),
      { weekStart: "", weekEnd: "", meetings: 0, notesSeen: 0, unchanged: 0, matched: 0, skippedInternal: 0, unmatched: 0 },
    );
    const state: GranolaSyncState = { lastSyncAt: now, lastSuccessAt: now, lastError: null, lastResult: total, trigger };
    await writeSyncState(state).catch(() => {});
    return { results, state };
  } catch (err) {
    const state: GranolaSyncState = {
      lastSyncAt: now,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastError: friendlySyncError(err),
      lastResult: previous?.lastResult ?? null,
      trigger,
    };
    await writeSyncState(state).catch(() => {});
    throw Object.assign(new Error(state.lastError ?? "Granola sync failed."), { state });
  }
}

/** This week and last week (Mon–Sun), in Toronto time. */
export function currentAndPreviousWeek(now = new Date()): Array<{ start: string; end: string }> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(now); // yyyy-MM-dd
  const d = parseISO(today);
  const mondayOffset = (d.getDay() + 6) % 7;
  const monday = addDays(d, -mondayOffset);
  const week = (m: Date) => ({ start: format(m, "yyyy-MM-dd"), end: format(addDays(m, 6), "yyyy-MM-dd") });
  return [week(addDays(monday, -7)), week(monday)];
}
