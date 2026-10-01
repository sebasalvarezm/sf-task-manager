import { describe, expect, it } from "vitest";
import type { GranolaNote } from "../lib/granola";
import {
  graphTimeToUtcIso,
  isInternalOnlyNote,
  matchNotesToMeetings,
  titleSimilarity,
  type MatchableMeeting,
} from "../lib/granola-match";

let n = 0;
function note(partial: Partial<GranolaNote> & { start?: string; emails?: string[]; eventId?: string | null }): GranolaNote {
  n++;
  const id = `not_${String(n).padStart(14, "0")}`;
  return {
    id,
    object: "note",
    title: partial.title ?? "Untitled",
    owner: { name: "Sebastian Alvarez", email: "sebastian@valstonecorp.com" },
    created_at: partial.start ?? "2026-09-29T14:00:00Z",
    updated_at: partial.start ?? "2026-09-29T14:00:00Z",
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: {
      event_title: partial.title ?? null,
      invitees: (partial.emails ?? []).map((email) => ({ email })),
      organiser: "sebastian@valstonecorp.com",
      calendar_event_id: partial.eventId ?? null,
      scheduled_start_time: partial.start ?? null,
      scheduled_end_time: null,
    },
    attendees: [{ name: "Sebastian Alvarez", email: "sebastian@valstonecorp.com" }],
    summary_text: "summary",
    summary_markdown: "summary",
    ...partial,
  } as GranolaNote;
}

const meeting = (eventId: string, subject: string, startUtc: string, emails: string[]): MatchableMeeting => ({
  eventId,
  subject,
  startUtc,
  attendeeEmails: ["sebastian@valstonecorp.com", ...emails],
});

describe("matchNotesToMeetings", () => {
  it("uses the calendar event link when Granola has one, even if times differ", () => {
    const m = meeting("AAMkAD-1", "Kallik / Valstone", "2026-09-29T14:00:00Z", ["ceo@kallik.com"]);
    const linked = note({ eventId: "AAMkAD-1", title: "Something else", start: "2026-09-29T18:00:00Z", emails: ["ceo@kallik.com"] });
    const [match] = matchNotesToMeetings([m], [linked]);
    expect(match).toMatchObject({ eventId: "AAMkAD-1", matchedBy: "calendar_event" });
  });

  it("also accepts the iCalUId as the link", () => {
    const m = { ...meeting("evt-2", "Call", "2026-09-29T14:00:00Z", []), iCalUId: "040000008200E00074C5B7101A82E008" };
    const linked = note({ eventId: "040000008200E00074C5B7101A82E008", emails: ["a@b.com"] });
    expect(matchNotesToMeetings([m], [linked])[0]?.matchedBy).toBe("calendar_event");
  });

  it("matches on start time within 15 minutes plus a shared attendee email (case-insensitive)", () => {
    const m = meeting("evt-3", "Valstone & StructurePoint Reconnect", "2026-10-01T15:30:00Z", ["alsamsam@structurepoint.org"]);
    const late = note({ title: "Reconnect", start: "2026-10-01T15:41:00Z", emails: ["alsamsam@StructurePoint.org"] });
    expect(matchNotesToMeetings([m], [late])[0]?.matchedBy).toBe("time_and_attendees");
  });

  it("matches on time plus a similar title when attendees are missing", () => {
    const m = meeting("evt-4", "Qualtech & Valstone", "2026-10-01T18:30:00Z", ["deb@teamqsi.com"]);
    const titled = note({ title: "Qualtech & Valstone", start: "2026-10-01T18:32:00Z", emails: ["someone@gmail.com"] });
    expect(matchNotesToMeetings([m], [titled])[0]?.matchedBy).toBe("time_and_title");
  });

  it("does not match more than 15 minutes apart", () => {
    const m = meeting("evt-5", "Qualtech & Valstone", "2026-10-01T18:30:00Z", ["deb@teamqsi.com"]);
    const far = note({ title: "Qualtech & Valstone", start: "2026-10-01T18:46:00Z", emails: ["deb@teamqsi.com"] });
    expect(matchNotesToMeetings([m], [far])).toEqual([]);
  });

  it("does not match on time alone", () => {
    const m = meeting("evt-6", "Kallik / Valstone", "2026-10-01T18:30:00Z", ["ceo@kallik.com"]);
    const other = note({ title: "Amlab intro", start: "2026-10-01T18:30:00Z", emails: ["jawn.l@amlab.com.au"] });
    expect(matchNotesToMeetings([m], [other])).toEqual([]);
  });

  it("skips internal-only notes, even in the same slot as an external meeting", () => {
    const m = meeting("evt-7", "Weekly sync", "2026-10-01T13:00:00Z", ["x@client.com"]);
    const internal = note({ title: "Weekly sync", start: "2026-10-01T13:00:00Z", emails: ["nate@valstonecorp.com", "carl@valsoftcorp.com"] });
    expect(isInternalOnlyNote(internal)).toBe(true);
    expect(matchNotesToMeetings([m], [internal])).toEqual([]);
  });

  it("pairs each note with at most one meeting, preferring the closer, better match", () => {
    const a = meeting("evt-a", "Kallik / Valstone", "2026-10-01T14:00:00Z", ["ceo@kallik.com"]);
    const b = meeting("evt-b", "Kallik follow-up", "2026-10-01T14:10:00Z", ["cfo@kallik.com"]);
    const noteA = note({ title: "Kallik", start: "2026-10-01T14:01:00Z", emails: ["ceo@kallik.com"] });
    const noteB = note({ title: "Kallik", start: "2026-10-01T14:11:00Z", emails: ["cfo@kallik.com"] });
    const result = matchNotesToMeetings([a, b], [noteB, noteA]);
    expect(Object.fromEntries(result.map((r) => [r.eventId, r.note.id]))).toEqual({
      "evt-a": noteA.id,
      "evt-b": noteB.id,
    });
  });
});

describe("helpers", () => {
  it("ignores filler words when comparing titles", () => {
    expect(titleSimilarity("Valstone & Sente Group Market Update", "Sente Group update call")).toBeGreaterThanOrEqual(0.5);
    expect(titleSimilarity("Intro call", "Valstone meeting")).toBe(0);
  });

  it("reads Graph's UTC times as UTC", () => {
    expect(graphTimeToUtcIso("2026-10-01T15:30:00.0000000", "UTC")).toBe("2026-10-01T15:30:00Z");
    expect(Date.parse(graphTimeToUtcIso("2026-10-01T15:30:00.0000000", "UTC"))).toBe(Date.parse("2026-10-01T15:30:00Z"));
    expect(graphTimeToUtcIso("2026-10-01T15:30:00Z", "UTC")).toBe("2026-10-01T15:30:00Z");
  });
});
