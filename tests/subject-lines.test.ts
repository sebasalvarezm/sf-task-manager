import { describe, expect, it } from "vitest";
import { buildSubjectLines, compareVerdict, subjectStyle, type SendRow } from "../lib/outcomes-analysis";

describe("subjectStyle", () => {
  it("sorts generic and specific subjects", () => {
    expect(subjectStyle("Lunch: Valstone")).toBe("generic");
    expect(subjectStyle("lunch - Valstone")).toBe("generic");
    expect(subjectStyle("Coffee: Valstone")).toBe("generic");
    expect(subjectStyle("40 West Nov 11: Valstone")).toBe("specific");
    expect(subjectStyle("Amarone Oct 7: Valstone")).toBe("specific");
    expect(subjectStyle("Gaucho 11 November: Valstone")).toBe("specific");
    expect(subjectStyle("Quick follow-up")).toBeNull();
    expect(subjectStyle(null)).toBeNull();
  });
});

describe("compareVerdict", () => {
  it("says when there is too little data, and when the gap is real", () => {
    expect(compareVerdict({ sends: 10, replies: 1, rate: 0.1, low: 0, high: 0 }, { sends: 10, replies: 3, rate: 0.3, low: 0, high: 0 })).toBe("Too few emails to tell");
    expect(compareVerdict({ sends: 400, replies: 12, rate: 0.03, low: 0, high: 0 }, { sends: 400, replies: 36, rate: 0.09, low: 0, high: 0 })).toMatch(/^Clear difference: Specific/);
    expect(compareVerdict({ sends: 200, replies: 10, rate: 0.05, low: 0, high: 0 }, { sends: 200, replies: 11, rate: 0.055, low: 0, high: 0 })).toBe("No clear difference");
  });
});

describe("buildSubjectLines", () => {
  const row = (sender: string, subject: string, replied: boolean): SendRow => ({
    sent_on: "2026-09-01", sender, subject_type: "E1", country: null, employees: null, founded: null, industry: null, prior_sends: 0,
    weekday: null, hour_et: null, mailing_id: "m", sequence_name: "[E] - Logistics — Rail", subject, opened: null, replied_at: replied ? "2026-09-05" : null, call_on: null,
  });
  it("builds team, you, by sender and by group", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => row("Sebastian Alvarez", "Gaucho Nov 11: Valstone", i < 3)),
      ...Array.from({ length: 12 }, (_, i) => row("Ilan", "Lunch: Valstone", i < 1)),
      row("Carl", "Quick follow-up", false),
    ];
    const r = buildSubjectLines(rows);
    expect(r.team.specific.sends).toBe(12);
    expect(r.team.generic.sends).toBe(12);
    expect(r.you?.specific.replies).toBe(3);
    expect(r.bySender.map((s) => s.label).sort()).toEqual(["Ilan", "Sebastian Alvarez"]);
    expect(r.byGroup[0].label).toBe("Logistics — Rail");
    expect(r.unsorted).toBe(1);
  });
});
