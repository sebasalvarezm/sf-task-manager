import { describe, expect, it } from "vitest";
import { auc, buildReport, employeesBand, fitLogistic, foundedBand, headlineLevels, wilson, type SendRow } from "../lib/outcomes-analysis";

function row(i: number, over: Partial<SendRow> = {}): SendRow {
  const d = new Date(Date.UTC(2025, 9, 1) + i * 86_400_000 * 0.5).toISOString().slice(0, 10);
  return {
    sent_on: d,
    sender: "Sebastian Alvarez",
    subject_type: "E1",
    country: "Canada",
    employees: 40,
    founded: 2005,
    industry: "Software",
    prior_sends: 0,
    weekday: 2,
    hour_et: 9,
    mailing_id: "m",
    sequence_name: "VMS E1",
    subject: "Valstone / Acme",
    opened: true,
    replied_at: null,
    call_on: null,
    ...over,
  };
}

describe("wilson interval", () => {
  it("is wide on tiny samples and narrow on large ones", () => {
    const small = wilson(3, 5);
    const large = wilson(300, 500);
    expect(small.high - small.low).toBeGreaterThan(0.5);
    expect(large.high - large.low).toBeLessThan(0.1);
    expect(large.low).toBeLessThan(0.6);
    expect(large.high).toBeGreaterThan(0.6);
  });
  it("stays inside 0..1", () => {
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
  });
});

describe("auc", () => {
  it("is 1 for perfect ranking, 0.5 for random-looking ties", () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.5);
    expect(auc([0.1, 0.2], [1, 1])).toBeNull();
  });
});

describe("logistic fit", () => {
  it("learns a feature that drives the label", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = i % 2;
      X.push([a, (i >> 1) % 2]);
      y.push(a === 1 ? (i % 5 === 0 ? 0 : 1) : i % 5 === 0 ? 1 : 0);
    }
    const w = fitLogistic(X, y);
    expect(w[0]).toBeGreaterThan(1);
    expect(Math.abs(w[1])).toBeLessThan(0.5);
  });
});

describe("bands", () => {
  it("bucket headcount and founding year", () => {
    expect(employeesBand(null)).toBe("Unknown");
    expect(employeesBand(19)).toBe("Under 20");
    expect(employeesBand(20)).toBe("20 to 49");
    expect(foundedBand(2019)).toBe("2010s");
    expect(foundedBand(2020)).toBe("2020 or later");
  });
});

describe("report", () => {
  it("finds a sender whose rate is clearly higher, and confirms it on the holdout", () => {
    const rows: SendRow[] = [];
    for (let i = 0; i < 600; i++) {
      const strong = i % 2 === 0;
      rows.push(row(i, { sender: strong ? "Strong" : "Weak", replied_at: (strong ? i % 4 === 0 : i % 10 === 1) ? "2026-01-01T00:00:00Z" : null }));
    }
    const r = buildReport(rows, "2026-10-19T00:00:00Z");
    expect(r.sends).toBe(600);
    expect(r.replyRate).toBeCloseTo((150 + 60) / 600, 2);
    const sender = r.features.find((f) => f.key === "sender")!;
    const strong = sender.levels.find((l) => l.level === "Strong")!;
    const weak = sender.levels.find((l) => l.level === "Weak")!;
    expect(strong.rate).toBeCloseTo(0.5, 2);
    expect(weak.rate).toBeCloseTo(0.2, 2);
    expect(strong.holds).toBe(true);
    expect(weak.holds).toBe(true);
    expect(strong.lift).toBeGreaterThan(1.3);
    const heads = headlineLevels(r);
    expect(heads.map((h) => h.level)).toContain("Strong");
    expect(r.model.auc).not.toBeNull();
    expect(r.model.auc!).toBeGreaterThan(0.6);
  });

  it("does not trust thin levels", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i, { replied_at: i % 10 === 0 ? "2026-01-01T00:00:00Z" : null }));
    rows.push(row(101, { sender: "Newbie", replied_at: "2026-01-01T00:00:00Z" }));
    const r = buildReport(rows);
    const newbie = r.features.find((f) => f.key === "sender")!.levels.find((l) => l.level === "Newbie")!;
    expect(newbie.rate).toBe(1);
    expect(newbie.holds).toBeNull();
    expect(headlineLevels(r).some((h) => h.level === "Newbie")).toBe(false);
  });

  it("handles an empty table", () => {
    const r = buildReport([]);
    expect(r.sends).toBe(0);
    expect(r.model.auc).toBeNull();
  });
});
