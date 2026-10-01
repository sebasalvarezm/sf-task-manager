// Match Granola notes to Call Logger meeting rows.
//
// Order of evidence:
//   1. The calendar event link, when Granola has one and it equals the
//      Outlook event id (or its iCalUId). That is a sure match.
//   2. Otherwise the start time must be within 15 minutes, AND either the
//      titles look alike or at least one external attendee email is shared.
//      Time alone is not enough: back-to-back calls start 30 minutes apart,
//      but two notes in the same slot (a double-booking) would collide.
//
// Notes whose people are all internal (Valstone and sister domains) are
// skipped before matching, and never stored.
//
// Pure functions only, so this is fully unit-tested.

import type { GranolaNote } from "./granola";

/** Same internal-domain list the Call Logger uses to skip internal meetings. */
export const INTERNAL_DOMAINS = [
  "valstonecorp.com",
  "valsoftcorp.com",
  "awsys.com",
  "valstonecorporation.onmicrosoft.com",
  "creativeinfo.net",
];

export const MATCH_WINDOW_MS = 15 * 60 * 1000;

export type MatchableMeeting = {
  eventId: string;
  iCalUId?: string | null;
  subject: string;
  /** Start as an absolute ISO time (with Z or an offset). */
  startUtc: string;
  /** Every attendee and organiser email on the calendar event, lowercased. */
  attendeeEmails: string[];
};

export type MatchedBy = "calendar_event" | "time_and_attendees" | "time_and_title";

export type NoteMatch = {
  eventId: string;
  note: GranolaNote;
  matchedBy: MatchedBy;
};

function domainOf(email: string): string {
  return email.split("@")[1]?.trim().toLowerCase() ?? "";
}

export function isInternalEmail(email: string): boolean {
  return INTERNAL_DOMAINS.includes(domainOf(email));
}

/** Everyone on the note other than whoever owns it, lowercased and deduped. */
export function noteEmails(note: GranolaNote): string[] {
  const emails = [
    ...(note.attendees ?? []).map((a) => a.email),
    ...(note.calendar_event?.invitees ?? []).map((i) => i.email),
    note.calendar_event?.organiser ?? "",
  ]
    .map((e) => (e ?? "").trim().toLowerCase())
    .filter((e) => e.includes("@"));
  return Array.from(new Set(emails));
}

/**
 * True when nobody outside Valstone is on the note. A note with no emails at
 * all also counts as internal: there is nothing tying it to a company call.
 */
export function isInternalOnlyNote(note: GranolaNote): boolean {
  return noteEmails(note).every(isInternalEmail);
}

export function noteStartMs(note: GranolaNote): number | null {
  const raw = note.calendar_event?.scheduled_start_time ?? note.created_at;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

const TITLE_NOISE = new Set([
  "valstone", "and", "the", "re", "fw", "fwd", "call", "meeting", "intro", "introduction",
  "with", "x", "of", "to", "a", "catch", "up", "sync", "touchpoint", "chat",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !TITLE_NOISE.has(t)),
  );
}

/** 0..1: share of meaningful words the two titles have in common. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

const TITLE_MATCH = 0.5;

function scorePair(meeting: MatchableMeeting, note: GranolaNote): { score: number; by: MatchedBy } | null {
  const linkId = note.calendar_event?.calendar_event_id?.trim();
  if (linkId && (linkId === meeting.eventId || (meeting.iCalUId && linkId === meeting.iCalUId))) {
    return { score: 1000, by: "calendar_event" };
  }
  const noteMs = noteStartMs(note);
  const meetingMs = Date.parse(meeting.startUtc);
  if (noteMs === null || !Number.isFinite(meetingMs)) return null;
  const gap = Math.abs(noteMs - meetingMs);
  if (gap > MATCH_WINDOW_MS) return null;

  const external = new Set(meeting.attendeeEmails.map((e) => e.toLowerCase()).filter((e) => !isInternalEmail(e)));
  const sharesAttendee = noteEmails(note).some((e) => external.has(e));
  const similarity = Math.max(
    titleSimilarity(meeting.subject, note.title ?? ""),
    titleSimilarity(meeting.subject, note.calendar_event?.event_title ?? ""),
  );
  if (!sharesAttendee && similarity < TITLE_MATCH) return null;

  // Closer in time and more evidence ranks higher.
  const closeness = 1 - gap / MATCH_WINDOW_MS; // 0..1
  const score = (sharesAttendee ? 300 : 0) + similarity * 200 + closeness * 100;
  return { score, by: sharesAttendee ? "time_and_attendees" : "time_and_title" };
}

/**
 * Best one-to-one pairing of notes to meetings. Internal-only notes are left
 * out. A note can match at most one meeting and vice versa.
 */
export function matchNotesToMeetings(meetings: MatchableMeeting[], notes: GranolaNote[]): NoteMatch[] {
  const pairs: Array<{ meeting: MatchableMeeting; note: GranolaNote; score: number; by: MatchedBy }> = [];
  for (const note of notes) {
    if (isInternalOnlyNote(note)) continue;
    for (const meeting of meetings) {
      const scored = scorePair(meeting, note);
      if (scored) pairs.push({ meeting, note, ...scored });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedMeetings = new Set<string>();
  const usedNotes = new Set<string>();
  const matches: NoteMatch[] = [];
  for (const pair of pairs) {
    if (usedMeetings.has(pair.meeting.eventId) || usedNotes.has(pair.note.id)) continue;
    usedMeetings.add(pair.meeting.eventId);
    usedNotes.add(pair.note.id);
    matches.push({ eventId: pair.meeting.eventId, note: pair.note, matchedBy: pair.by });
  }
  return matches;
}

/** Graph returns calendarView times in UTC without a "Z". Make them absolute. */
export function graphTimeToUtcIso(dateTime: string, timeZone: string | undefined): string {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(dateTime)) return dateTime;
  if (!timeZone || timeZone.toUpperCase() === "UTC") return `${dateTime.replace(/\.\d+$/, "")}Z`;
  // Only UTC is requested from Graph; anything else is left as-is (parsed as local).
  return dateTime;
}
