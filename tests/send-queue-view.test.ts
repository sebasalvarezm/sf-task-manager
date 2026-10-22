import { describe, expect, it } from "vitest";
import { ago, newestFirst, plainError, stageOf, statusLine, type ViewRow } from "@/lib/send-queue-view";

const now = Date.parse("2026-10-22T16:00:00Z");
const base: ViewRow = { status: "approved", status_reason: null, scheduled_for: null, time_zone: "America/Chicago", approved_at: "2026-10-22T15:58:00Z", outreach_mailing_id: null };

describe("stageOf", () => {
  it("groups review statuses together", () => {
    for (const s of ["pending", "review", "ready"] as const) expect(stageOf({ ...base, status: s }, now)).toBe("review");
  });
  it("approved and failed are ready to send", () => {
    expect(stageOf(base, now)).toBe("ready");
    expect(stageOf({ ...base, status: "failed" }, now)).toBe("ready");
  });
  it("an approved row just handed to Outreach shows as scheduled", () => {
    expect(stageOf(base, now, true)).toBe("scheduled");
  });
  it("a scheduled mailing whose time has passed is sent", () => {
    expect(stageOf({ ...base, status: "scheduled", scheduled_for: "2026-10-22T12:00:00Z", outreach_mailing_id: "1" }, now)).toBe("sent");
    expect(stageOf({ ...base, status: "scheduled", scheduled_for: "2026-10-23T12:00:00Z", outreach_mailing_id: "1" }, now)).toBe("scheduled");
  });
  it("manual-mode enrolments (no time, no mailing) stay scheduled", () => {
    expect(stageOf({ ...base, status: "scheduled" }, now)).toBe("scheduled");
  });
  it("dry runs never count as sent", () => {
    expect(stageOf({ ...base, status: "dry_run", scheduled_for: "2026-10-20T12:00:00Z", outreach_mailing_id: "1" }, now)).toBe("scheduled");
  });
});

describe("plainError", () => {
  it("never shows raw JSON", () => {
    const out = plainError('Outreach refused the mailing: {"errors":[{"id":"validationError","title":"Validation Error","detail":"Prospect email is opted out"}]}');
    expect(out).toBe("Outreach refused it: prospect email is opted out.");
    expect(out).not.toMatch(/[{}"]/);
  });
  it("copes with JSON cut off mid-way", () => {
    const out = plainError('Outreach would not schedule the mailing: {"errors":[{"id":"x","detail":"Mailbox is not connected","source":{"poin');
    expect(out).toBe("Outreach would not schedule it: mailbox is not connected.");
  });
  it("keeps plain sentences and makes them one line", () => {
    expect(plainError("Missing contact email\nor sequence")).toBe("Missing contact email or sequence.");
  });
  it("has a fallback", () => {
    expect(plainError(null)).toBe("Something went wrong sending this one.");
  });
});

describe("statusLine", () => {
  it("says approved and not sent", () => {
    expect(statusLine(base, { now })).toEqual({ text: "Approved 2 min ago · not sent", tone: "neutral" });
  });
  it("shows the scheduled time in the recipient's zone", () => {
    const line = statusLine({ ...base, status: "scheduled", scheduled_for: "2026-10-27T12:12:00Z", outreach_mailing_id: "1" }, { now });
    expect(line.text).toBe("Scheduled for Tue 7:12 AM recipient time (CDT)");
  });
  it("sent is green, dry run amber, failures red", () => {
    expect(statusLine({ ...base, status: "sent", scheduled_for: "2026-10-21T11:52:00Z" }, { now }).tone).toBe("ok");
    expect(statusLine({ ...base, status: "dry_run", scheduled_for: "2026-10-27T12:12:00Z" }, { now }).tone).toBe("warn");
    expect(statusLine({ ...base, status: "failed", status_reason: "x" }, { now }).tone).toBe("danger");
  });
  it("manual mode tells me to send it from Outreach", () => {
    expect(statusLine({ ...base, status: "scheduled" }, { now, manualSend: true }).text).toBe("In the sequence, send it from Outreach");
  });
});

describe("helpers", () => {
  it("ago", () => {
    expect(ago("2026-10-22T15:59:50Z", now)).toBe("just now");
    expect(ago("2026-10-22T13:00:00Z", now)).toBe("3 h ago");
  });
  it("newestFirst", () => {
    const rows = [{ ...base, approved_at: "2026-10-22T10:00:00Z" }, { ...base, approved_at: "2026-10-22T12:00:00Z" }];
    expect(newestFirst(rows)[0].approved_at).toBe("2026-10-22T12:00:00Z");
  });
});
