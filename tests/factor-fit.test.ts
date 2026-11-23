import { describe, expect, it } from "vitest";
import { fitFactorsFrom, fitFor, qualityOf } from "@/lib/factor-fit";
import { fitBand, fitText, sortRows } from "@/app/components/FitSort";
import { DEFAULT_QUALITY_THRESHOLDS } from "@/lib/outreach-quality";
import type { FactorState } from "@/lib/outcomes-factors-store";

const result = (id: string, verdict: string, effectPer100: number) => ({ latest: { id, verdict, effectPer100 }, history: [], firstTestedAt: "2026-11-23" });
const anz = { id: "anz-vs-us", label: "Australia and New Zealand vs US", question: "?", test: [{ field: "country", op: "matches", value: "^(australia|new zealand)$" }], compare: [{ field: "country_group", op: "in", value: ["US"] }], aLabel: "AU/NZ", bLabel: "US" };
const state = {
  proposals: [
    { spec: anz, status: "approved", proposedAt: "2026-11-20" },
    { spec: { ...anz, id: "rejected-one" }, status: "rejected", proposedAt: "2026-11-20" },
  ],
  results: {
    "anz-vs-us": result("anz-vs-us", "act", 14.6),
    "clean-canada-vs-us": result("clean-canada-vs-us", "act", 11.3),
    "europe-vs-us": result("europe-vs-us", "act", 7.3),
    "clean-founded-2010s": result("clean-founded-2010s", "act", 6.5),
    "recontact-new-person": result("recontact-new-person", "act", -5.9),
    evening: result("evening", "promising", 4.2), // not act: ignored
    friday: result("friday", "act", -3), // timing, not about the company: ignored
    "rejected-one": result("rejected-one", "act", 50), // rejected proposal: ignored
    "size-15-49": result("size-15-49", "nothing", 2),
  },
  trends: null,
  testedAt: "2026-11-23T03:00:00Z",
} as unknown as FactorState;

describe("which factors rank accounts", () => {
  it("takes only Act on it company factors, strongest first, and turns the contact factor into a note", () => {
    const { factors, contactNote } = fitFactorsFrom(state);
    expect(factors.map((f) => [f.id, f.effect])).toEqual([
      ["anz-vs-us", 14.6],
      ["clean-canada-vs-us", 11.3],
      ["europe-vs-us", 7.3],
      ["clean-founded-2010s", 6.5],
    ]);
    expect(contactNote).toBe("On re-contacts, email the same person again (5.9 more replies per 100 than a new person).");
  });
  it("is empty, not broken, before any rebuild", () => {
    expect(fitFactorsFrom({ proposals: [], results: {}, trends: null, testedAt: null })).toEqual({ factors: [], contactNote: null });
  });
});

describe("fit per account", () => {
  const { factors } = fitFactorsFrom(state);
  const t = DEFAULT_QUALITY_THRESHOLDS;
  const facts = (country: string | null, founded: number | null, employees: number | null) => ({
    country,
    industry: null,
    employees,
    founded,
    prior_sends: 1,
    quality: qualityOf(country, founded, employees, t),
  });
  it("adds up every matching factor", () => {
    const au = fitFor(facts("Australia", 2014, 40), factors);
    expect(au.score).toBe(21.1);
    expect(au.hits.map((h) => h.id)).toEqual(["anz-vs-us", "clean-founded-2010s"]);
    expect(fitFor(facts("Canada", 1995, 40), factors)).toMatchObject({ score: 11.3 });
    // Germany is outside the default core countries, so it is not "clean": Europe counts, founded 2010s does not.
    expect(qualityOf("Germany", 2012, 40, t)).toBe("potential");
    expect(fitFor(facts("Germany", 2012, 40), factors).score).toBe(7.3);
  });
  it("clean-only factors skip companies that are not clean, and unknown founded never counts", () => {
    // Founded 2021 fails the founded check, so it is not clean: the Canada (clean) factor does not apply.
    expect(qualityOf("Canada", 2021, 40, t)).toBe("potential");
    expect(fitFor(facts("Canada", 2021, 40), factors).score).toBe(0);
    // No founded year: not clean either, so only country factors that need no quality apply.
    expect(fitFor(facts("Germany", null, 40), factors).score).toBe(7.3);
    expect(fitFor(facts("United States", 2015, 40), factors).score).toBe(6.5);
    expect(fitFor(facts(null, null, null), factors)).toEqual({ score: 0, hits: [] });
  });
});

describe("sorting and bands", () => {
  type R = { id: string; fit: { score: number; hits: Array<{ id: string; label: string; short: string; effect: number }> } | null; founded: number | null; employees: number | null; sends: number | null };
  const hit = (n: number) => [{ id: "x", label: "x", short: "x", effect: n }];
  const rows: R[] = [
    { id: "a", fit: { score: 0, hits: [] }, founded: 1990, employees: 30, sends: 2 },
    { id: "b", fit: { score: 21.1, hits: hit(21.1) }, founded: null, employees: 12, sends: 1 },
    { id: "c", fit: { score: -5, hits: hit(-5) }, founded: 2015, employees: null, sends: 3 },
    { id: "d", fit: { score: 7.3, hits: hit(7.3) }, founded: 1975, employees: 80, sends: 1 },
    { id: "e", fit: null, founded: 2001, employees: 30, sends: null },
  ];
  const facts = (r: R) => r;
  const ids = (k: Parameters<typeof sortRows>[1]) => sortRows(rows, k, facts).map((r) => r.id).join("");
  it("each sort puts unknowns last and keeps ties in their incoming order", () => {
    expect(ids("fit")).toBe("bdace");
    expect(ids("default")).toBe("abcde");
    expect(ids("founded_asc")).toBe("daecb");
    expect(ids("founded_desc")).toBe("ceadb");
    expect(ids("employees_asc")).toBe("baedc");
    expect(ids("employees_desc")).toBe("daebc");
    expect(ids("sends_asc")).toBe("bdace");
    expect(ids("sends_desc")).toBe("cabde");
  });
  it("bands and the one-line reason", () => {
    expect(fitBand(rows[1].fit).key).toBe("strong");
    expect(fitBand(rows[3].fit).key).toBe("good");
    expect(fitBand({ score: 6.5, hits: hit(6.5) }).key).toBe("slight");
    expect(fitBand(rows[0].fit).key).toBe("none");
    expect(fitBand(null).key).toBe("none");
    expect(fitBand(rows[2].fit).key).toBe("against");
    expect(fitText({ score: 21.1, hits: [{ id: "a", label: "A", short: "AU/NZ", effect: 14.6 }, { id: "b", label: "B", short: "founded 2010 to 2019", effect: 6.5 }] })).toBe("Fit +21.1 · AU/NZ +14.6, founded 2010 to 2019 +6.5");
    expect(fitText({ score: 0, hits: [] })).toBeNull();
  });
});
