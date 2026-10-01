import { describe, expect, it } from "vitest";
import { externalMeetingsFromEvents } from "../lib/call-logger-meetings";

const ev = (over: Partial<Parameters<typeof externalMeetingsFromEvents>[0][number]>) => ({
  id: "e",
  iCalUId: null,
  subject: "s",
  start: "2026-09-29T14:00:00.0000000",
  end: "2026-09-29T14:30:00.0000000",
  startTimeZone: "UTC",
  organizer: { name: "Seb", email: "sebastian@valstonecorp.com" },
  attendees: [],
  bodyText: "",
  ...over,
});

describe("Call Logger rows from calendar events", () => {
  it("keeps meetings with an external attendee and drops internal-only ones", () => {
    const rows = externalMeetingsFromEvents([
      ev({ id: "ext", attendees: [{ name: "", email: "CEO@Voxware.com" }] }),
      ev({ id: "int", attendees: [{ name: "", email: "nate@valstonecorp.com" }] }),
    ]);
    expect(rows.map((r) => r.event.id)).toEqual(["ext"]);
    expect(rows[0]).toMatchObject({ externalDomains: ["voxware.com"], meetingDate: "2026-09-29", startTime: "14:00", startUtc: "2026-09-29T14:00:00Z" });
  });

  it("falls back to emails in the invite body when attendees were stripped", () => {
    const rows = externalMeetingsFromEvents([ev({ id: "body", bodyText: "Join: jawn.l@amlab.com.au" })]);
    expect(rows[0]?.externalDomains).toEqual(["amlab.com.au"]);
    expect(rows[0]?.emails).toContain("jawn.l@amlab.com.au");
  });
});
