import { describe, expect, it } from "vitest";
import type { PastCall } from "../lib/call-history";
import {
  buildSuggestionPrompt,
  dropUnsupportedFacts,
  followUpDaysFromTiming,
  parseSuggestion,
  selectExamples,
  type SuggestionInput,
} from "../lib/call-suggest";

const past = (commentary: string, extra: Partial<PastCall> = {}): PastCall => ({
  source: "salesforce",
  accountId: null,
  accountName: "X",
  callType: "C1",
  commentary,
  meetingDate: "2026-09-01",
  ...extra,
});

const input: SuggestionInput = {
  meetingTitle: "Voxware / Valstone",
  meetingDate: "2026-09-24",
  accountName: "Voxware",
  accountHistory: [],
  summary: "Revenue about $4M. 20 staff. Founder open to a sale. Will send a review package; IC within a week.",
  transcript: "Them: we're at about four million in revenue and 20 people.",
};

describe("selectExamples", () => {
  const history = Array.from({ length: 40 }, (_, i) => past(`Line ${i}, open to discuss`));
  const long = past("Profitable platform; strong traction; likely acquisition conversation within two years with significant upside");

  it("returns 15 to 25 examples, short lines only, corrections first", () => {
    const corrections = [past("Corrected: 4M rev, wants 5x", { source: "correction" })];
    const picked = selectExamples([long, ...history], corrections, "review package", 20);
    expect(picked.length).toBe(20);
    expect(picked[0].source).toBe("correction");
    expect(picked.some((c) => c.commentary.includes(";"))).toBe(false);
  });

  it("never goes below 15 when there is enough history, nor above 25", () => {
    expect(selectExamples(history, [], "x", 5).length).toBe(15);
    expect(selectExamples(history, [], "x", 99).length).toBe(25);
  });

  it("ranks lines that share words with this call higher", () => {
    const relevant = past("Will send review package, IC next week");
    const picked = selectExamples([...history, relevant], [], "IC review package", 15);
    expect(picked[0]).toBe(relevant);
  });
});

describe("fact guard", () => {
  it("drops a fragment whose number isn't in the notes", () => {
    expect(dropUnsupportedFacts("~$4M rev, 35 staff, open to sale", input.summary)).toBe("~$4M rev, open to sale");
  });
  it("keeps numbers said in words in the transcript", () => {
    expect(dropUnsupportedFacts("4M rev, 20 FTE", "about four million, twenty people")).toBe("4M rev, 20 FTE");
  });
});

describe("follow-up", () => {
  it("turns a date into days after the meeting", () => {
    expect(followUpDaysFromTiming({ kind: "date", date: "2026-10-15", reason: "" }, "2026-09-25")).toBe(20);
  });
  it("returns no follow-up for none, past dates or nonsense", () => {
    expect(followUpDaysFromTiming({ kind: "none", reason: "" }, "2026-09-25")).toBeNull();
    expect(followUpDaysFromTiming({ kind: "date", date: "2026-09-01", reason: "" }, "2026-09-25")).toBeNull();
    expect(followUpDaysFromTiming({ kind: "date", date: "soon", reason: "" }, "2026-09-25")).toBeNull();
  });
  it("caps at two years", () => {
    expect(followUpDaysFromTiming({ kind: "days", days: 5000, reason: "" }, "2026-09-25")).toBe(730);
  });
});

describe("parseSuggestion", () => {
  it("cleans the AI reply into fields, with the RCE worked out from the date", () => {
    const s = parseSuggestion(
      'Sure: {"commentary":"C1 - ~$4M rev, 20 staff; open to sale, IC within 1 week, 45 customers","callType":"C1","typeReason":"First call","followUp":{"kind":"date","date":"2026-09-30","reason":"IC within a week"}}',
      input,
    );
    expect(s.commentary).toBe("~$4M rev, 20 staff, open to sale, IC within 1 week");
    expect(s.callType).toBe("C1");
    expect(s.followUpDays).toBe(6);
    expect(s.followUpReason).toBe("IC within a week");
  });

  it("leaves type and follow-up empty when the call isn't clear", () => {
    const s = parseSuggestion('{"commentary":null,"callType":"maybe","followUp":{"kind":"none","reason":"no timing"}}', input);
    expect(s).toEqual({ commentary: null, callType: null, typeReason: null, followUpDays: null, followUpReason: null });
  });
});

describe("prompt", () => {
  it("includes the confirmed no-default rule and the examples", () => {
    const prompt = buildSuggestionPrompt(input, [past("Sub 2M, think will reach it next year", { followUpDays: 180 })]);
    expect(prompt).toContain("There is no default");
    expect(prompt).toContain("C1 - Sub 2M, think will reach it next year | follow-up RCE180");
    expect(prompt).toContain("If a fact isn't there, leave it out");
  });
});
