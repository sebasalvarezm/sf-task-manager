import { describe, expect, it } from "vitest";
import { planSendSlots, recipientTimeZone } from "../lib/send-slots";
import { interpret } from "../lib/email-verify";
import { estimateCost } from "../lib/model-cost";
import { matchSequence, normalizeSequenceName, rankContacts, splitDraft, titleRank } from "../lib/e1-sends";

describe("recipientTimeZone", () => {
  it("maps states, provinces and countries", () => {
    expect(recipientTimeZone("United States", "TX")).toBe("America/Chicago");
    expect(recipientTimeZone("United States", "California")).toBe("America/Los_Angeles");
    expect(recipientTimeZone("Canada", "BC")).toBe("America/Vancouver");
    expect(recipientTimeZone("Canada", "Quebec")).toBe("America/Toronto");
    expect(recipientTimeZone("Ireland", null)).toBe("Europe/Dublin");
    expect(recipientTimeZone("Australia", "Western Australia")).toBe("Australia/Perth");
    expect(recipientTimeZone(null, null)).toBe("America/New_York");
  });
});

describe("planSendSlots", () => {
  const local = (d: Date, tz: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
    return { minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), weekday: p.weekday };
  };
  it("splits a batch between the morning and evening windows, on weekdays, spaced apart", () => {
    // A Tuesday at 03:00 UTC: 23:00 Monday in Toronto, so the next windows are Tuesday.
    const now = new Date("2026-10-20T03:00:00Z");
    const reqs = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, timeZone: "America/Toronto" }));
    let seed = 7;
    const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const plan = planSendSlots(reqs, now, random);
    expect(plan).toHaveLength(20);
    const morning = plan.filter((p) => p.window === "morning");
    const evening = plan.filter((p) => p.window === "evening");
    expect(morning.length).toBe(10);
    expect(evening.length).toBe(10);
    for (const p of plan) {
      const l = local(p.at, "America/Toronto");
      expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(l.weekday);
      if (p.window === "morning") expect(l.minutes).toBeGreaterThanOrEqual(6 * 60 + 45);
      if (p.window === "morning") expect(l.minutes).toBeLessThanOrEqual(8 * 60);
      if (p.window === "evening") expect(l.minutes).toBeGreaterThanOrEqual(17 * 60);
      if (p.window === "evening") expect(l.minutes).toBeLessThanOrEqual(19 * 60);
    }
    const sorted = plan.map((p) => p.at.getTime()).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(5 * 60_000 - 1);
  });
  it("skips the weekend", () => {
    const now = new Date("2026-10-24T15:00:00Z"); // Saturday
    const plan = planSendSlots([{ id: "a", timeZone: "Europe/London" }], now, () => 0.3);
    expect(local(plan[0].at, "Europe/London").weekday).toBe("Mon");
  });
});

describe("email verdicts", () => {
  it("reads the verifier's fields in priority order", () => {
    expect(interpret({ result: "valid" })).toBe("valid");
    expect(interpret({ result: "valid", accept_all: true })).toBe("accept_all");
    expect(interpret({ result: "valid", role: true })).toBe("role");
    expect(interpret({ result: "invalid" })).toBe("invalid");
    expect(interpret({ result: "unknown" })).toBe("unknown");
  });
});

describe("cost estimate", () => {
  it("prices tokens and searches", () => {
    expect(estimateCost("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(3, 5);
    expect(estimateCost("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 2 } })).toBeCloseTo(0.02, 5);
  });
});

describe("send row helpers", () => {
  it("splits the Weekly Outreach draft into subject and body", () => {
    expect(splitDraft("Lunch: Valstone\n\nHi Tom,\n\nBody.")).toEqual({ subject: "Lunch: Valstone", body: "Hi Tom,\n\nBody." });
    expect(splitDraft(null)).toEqual({ subject: null, body: null });
  });
  it("ranks founders first and people with emails ahead of those without", () => {
    expect(titleRank("Co-Founder & CEO")).toBe(1);
    expect(titleRank("President")).toBe(4);
    expect(titleRank("Sales Manager")).toBe(7);
    const ranked = rankContacts([
      { Id: "1", FirstName: "A", LastName: "A", Name: "A A", Title: "VP Sales", Email: "a@x.com", AccountId: "acc" },
      { Id: "2", FirstName: "B", LastName: "B", Name: "B B", Title: "Founder", Email: null, AccountId: "acc" },
      { Id: "3", FirstName: "C", LastName: "C", Name: "C C", Title: "CEO", Email: "c@x.com", AccountId: "acc" },
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["2", "3", "1"]);
  });
  it("matches groups to the [E] sequences by name", () => {
    const seqs = [
      { id: "1", name: "[E] - Manufacturing → Production Quality", tags: [], enabled: true },
      { id: "2", name: "[E] - Agriculture — Grain & Crop", tags: [], enabled: true },
      { id: "3", name: "[D-E] - Carveout - Construction & Materials", tags: [], enabled: true },
      { id: "4", name: "[E] - Contractor", tags: [], enabled: true },
    ];
    expect(normalizeSequenceName("[E] - Agriculture — Grain & Crop")).toBe("agriculture grain crop");
    expect(matchSequence("Manufacturing — Production Quality", seqs, {})?.id).toBe("1");
    expect(matchSequence("Grain & Crop", seqs, {})?.id).toBe("2");
    expect(matchSequence("Contractor Solutions", seqs, {})).toBeNull();
    expect(matchSequence("Contractor Solutions", seqs, { "Contractor Solutions": "4" })?.id).toBe("4");
    expect(matchSequence("Construction & Materials", seqs, {})).toBeNull();
  });
});
