import { describe, expect, it } from "vitest";
import { buildTrends, countryGroup, emailKind, FACTOR_LIBRARY, firstNameFromEmail, leadDays, pValue, testFactor, testFactors, validateSpec, type FactorRow, type FactorSpec } from "@/lib/outcomes-factors";

// Deterministic pseudo-random numbers so the tests never flake.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function row(over: Partial<FactorRow>): FactorRow {
  return {
    sent_on: "2026-03-10",
    sender: "Bennett Fahey",
    subject_type: "E1",
    country: "United States",
    employees: 30,
    founded: 2005,
    industry: null,
    prior_sends: 0,
    weekday: 2,
    hour_et: 10,
    mailing_id: "m",
    sequence_name: "[E] - Mining",
    subject: "Lunch: Valstone",
    opened: null,
    replied_at: null,
    call_on: null,
    quality: "clean",
    ...over,
  };
}

const day = (i: number) => new Date(Date.UTC(2025, 6, 1) + (i % 300) * 86_400_000).toISOString().slice(0, 10);
const NN: FactorSpec = FACTOR_LIBRARY.find((f) => f.id === "subject-name-name")!;

describe("factor test", () => {
  it("a real effect: Name <> Name gets half the replies, held in both halves, so 'act: avoid'", () => {
    const r = rng(1);
    const rows: FactorRow[] = [];
    for (let i = 0; i < 4000; i++) {
      const nn = i % 4 === 0;
      const p = nn ? 0.08 : 0.18;
      rows.push(row({ sent_on: day(i), subject: nn ? "Intro: Valstone <> Acme" : "Amarone Oct 7: Valstone", replied_at: r() < p ? `${day(i)}T15:00:00Z` : null, sender: i % 3 ? "Bennett Fahey" : "Sebastian Alvarez" }));
    }
    const res = testFactor(NN, rows, "2026-11-17");
    expect(res.verdict).toBe("act");
    expect(res.direction).toBe("down");
    expect(res.halves).toBe("agree");
    expect(res.effectPer100!).toBeLessThan(-5);
    expect(res.effectPer100!).toBeGreaterThan(-15);
    expect(res.youA!.sends).toBeGreaterThan(0);
    expect(res.sentence).toMatch(/Act on it: avoid this/);
  });

  it("no effect: 'nothing there'", () => {
    const r = rng(2);
    const rows: FactorRow[] = [];
    for (let i = 0; i < 3000; i++) rows.push(row({ sent_on: day(i), subject: i % 4 === 0 ? "Intro: Valstone <> Acme" : "Amarone Oct 7: Valstone", replied_at: r() < 0.15 ? "2026-01-01T00:00:00Z" : null }));
    expect(["nothing", "promising"]).toContain(testFactor(NN, rows, "2026-11-17").verdict);
  });

  it("a fake effect from country mix is taken out by the adjustment", () => {
    // Canada replies 30%, US 10%. Name <> Name went mostly to Canada but does nothing itself.
    const r = rng(3);
    const rows: FactorRow[] = [];
    for (let i = 0; i < 6000; i++) {
      const canada = i % 2 === 0;
      const nn = canada ? r() < 0.6 : r() < 0.1;
      rows.push(row({ sent_on: day(i), country: canada ? "Canada" : "United States", subject: nn ? "Intro: Valstone <> Acme" : "Amarone Oct 7: Valstone", replied_at: r() < (canada ? 0.3 : 0.1) ? "2026-01-01T00:00:00Z" : null }));
    }
    const res = testFactor(NN, rows, "2026-11-17");
    expect(res.a.rate).toBeGreaterThan(res.b.rate + 0.05); // raw numbers look great...
    expect(res.verdict).not.toBe("act"); // ...but not after accounting for country
    expect(Math.abs(res.effectPer100!)).toBeLessThan(4);
  });

  it("too little data says so; sends without their full 45 days are left out", () => {
    const rows = [row({ subject: "Intro: Valstone <> Acme" }), row({}), row({ sent_on: "2026-11-10", subject: "Intro: A <> B" })];
    const res = testFactor(NN, rows, "2026-11-17");
    expect(res.verdict).toBe("thin");
    expect(res.a.sends).toBe(1);
    expect(res.sentence).toMatch(/Not enough data/);
  });

  it("every library factor runs without error on mixed data", () => {
    const r = rng(4);
    const countries = ["United States", "Canada", "United Kingdom", "Netherlands", "Australia"];
    const rows: FactorRow[] = [];
    for (let i = 0; i < 3000; i++) {
      rows.push(row({
        sent_on: day(i),
        account_id: `a${i % 900}`,
        account_name: `Acme${i % 900} Software`,
        contact_email: i % 7 === 0 ? "info@acme.com" : i % 11 === 0 ? "bob@gmail.com" : `john.smith${i % 5}@acme.com`,
        contact_title: ["CEO", "President", "VP Sales", "Director of Operations", null][i % 5],
        country: countries[i % 5],
        employees: 10 + (i % 90),
        founded: 1985 + (i % 38),
        weekday: i % 7,
        hour_et: 6 + (i % 15),
        prior_sends: i % 4 === 0 ? 1 : 0,
        subject: ["Amarone Oct 7: Valstone", "Lunch: Valstone", "Intro: Valstone <> Acme", "John, Acme and Valstone", "Let's Meet in Amsterdam"][i % 5],
        replied_at: r() < 0.18 ? `${day(i)}T12:00:00Z` : null,
      }));
    }
    const out = testFactors(FACTOR_LIBRARY, rows, "2026-11-17");
    expect(out).toHaveLength(FACTOR_LIBRARY.length);
    for (const res of out) expect(["act", "promising", "nothing", "thin"]).toContain(res.verdict);
  });
});

describe("fields", () => {
  it("country groups, email kinds, first names, lead days", () => {
    expect(countryGroup("United States")).toBe("US");
    expect(countryGroup("Netherlands")).toBe("Europe");
    expect(countryGroup("Australia")).toBe("Other");
    expect(countryGroup(null)).toBe("Unknown");
    expect(emailKind("info@acme.com")).toBe("generic");
    expect(emailKind("bob@gmail.com")).toBe("personal");
    expect(emailKind("bob.smith@acme.com")).toBe("company");
    expect(firstNameFromEmail("john.smith@acme.com")).toBe("john");
    expect(firstNameFromEmail("js@acme.com")).toBeNull();
    expect(leadDays("Prince & Pauper Dec 2: Valstone", "2026-11-17")).toBe(15);
    expect(leadDays("Amarone Jan 7: Valstone", "2026-12-20")).toBe(18); // next year
    expect(leadDays("Lunch: Valstone", "2026-11-17")).toBeNull();
  });
  it("p-values", () => {
    expect(pValue(1.96)).toBeCloseTo(0.05, 2);
    expect(pValue(0)).toBeCloseTo(1, 2);
  });
});

describe("proposed factors are checked before they can run", () => {
  it("accepts a clean spec and refuses unknown fields, bad patterns and wrong operators", () => {
    const ok = validateSpec({ id: "subject-question", label: "Question in subject", question: "Does a question mark help?", aLabel: "question", bLabel: "no question", test: [{ field: "subject", op: "matches", value: "\\?" }], scope: [{ field: "kind", op: "in", value: ["E1"] }], extra: "dropped" });
    expect("spec" in ok && ok.spec.test).toEqual([{ field: "subject", op: "matches", value: "\\?" }]);
    expect(validateSpec({ id: "x1", label: "a", question: "b", aLabel: "c", bLabel: "d", test: [{ field: "salary", op: "known" }] })).toEqual({ error: 'test: unknown field "salary".' });
    expect("error" in validateSpec({ id: "x1", label: "a", question: "b", aLabel: "c", bLabel: "d", test: [{ field: "subject", op: "matches", value: "(" }] })).toBe(true);
    expect("error" in validateSpec({ id: "x1", label: "a", question: "b", aLabel: "c", bLabel: "d", test: [{ field: "employees", op: "matches", value: "1" }] })).toBe(true);
    expect("error" in validateSpec({ id: "Bad Id", label: "a", question: "b", aLabel: "c", bLabel: "d", test: [{ field: "subject", op: "known" }] })).toBe(true);
  });
});

describe("trends", () => {
  it("weekly 14-day reply rate, Seb vs team, last 4 weeks vs the 4 before", () => {
    const rows: FactorRow[] = [];
    // 12 weeks back from 2026-10-26; Seb improves in the last 4 weeks.
    for (let w = 0; w < 12; w++) {
      const monday = new Date(Date.UTC(2026, 7, 10) + w * 7 * 86_400_000).toISOString().slice(0, 10);
      for (let i = 0; i < 20; i++) {
        const mine = i < 10;
        const replied = mine ? (w >= 8 ? i < 4 : i < 2) : i < 12;
        rows.push(row({ sent_on: monday, sender: mine ? "Sebastian Alvarez" : "Bennett Fahey", replied_at: replied ? `${monday}T20:00:00Z` : null, call_on: mine && i === 0 ? monday : null }));
      }
      // A reply after 20 days does not count in the 14-day window.
      rows.push(row({ sent_on: monday, sender: "Sebastian Alvarez", replied_at: new Date(Date.parse(monday) + 20 * 86_400_000).toISOString() }));
    }
    const t = buildTrends(rows, "2026-11-17");
    expect(t.you.weeks).toHaveLength(12);
    expect(t.you.weeks[11].week).toBe("2026-10-26");
    expect(t.you.last4.replyRate14).toBeCloseTo(4 / 11, 5);
    expect(t.you.prev4.replyRate14).toBeCloseTo(2 / 11, 5);
    expect(t.you.last4.calls).toBe(4);
    expect(t.team.last4.sends).toBe(84);
  });
});
