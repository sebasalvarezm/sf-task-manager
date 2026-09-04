import { describe, it, expect } from "vitest";
import {
  canonicalizeCountry,
  isTierOneCountry,
  extractYear,
  parseYearInput,
  parseEmployeesInput,
  parseCountryInput,
  scoreAccountQuality,
  aggregateOutreachQuality,
  coerceQualityThresholds,
  DEFAULT_QUALITY_THRESHOLDS,
  type QualityInput,
  type ScorableOutreachRow,
} from "../lib/outreach-quality";

// ── Country canonicalization ─────────────────────────────────────────────────

describe("canonicalizeCountry — spelling variants must not become false flags", () => {
  it("resolves US variants", () => {
    expect(canonicalizeCountry("us")).toBe("United States");
    expect(canonicalizeCountry("USA")).toBe("United States");
    expect(canonicalizeCountry("U.S.A.")).toBe("United States");
    expect(canonicalizeCountry("United States of America")).toBe("United States");
  });

  it("treats a two-letter CA as Canada, not California", () => {
    // In Salesforce the state lives in BillingState, so a country of CA is Canada.
    expect(canonicalizeCountry("CA")).toBe("Canada");
    expect(canonicalizeCountry("can")).toBe("Canada");
  });

  it("folds the UK home nations into United Kingdom", () => {
    expect(canonicalizeCountry("England")).toBe("United Kingdom");
    expect(canonicalizeCountry("Scotland")).toBe("United Kingdom");
    expect(canonicalizeCountry("Wales")).toBe("United Kingdom");
    expect(canonicalizeCountry("Northern Ireland")).toBe("United Kingdom");
    expect(canonicalizeCountry("GB")).toBe("United Kingdom");
    expect(canonicalizeCountry("Great Britain")).toBe("United Kingdom");
  });

  it("keeps Ireland distinct from the UK", () => {
    expect(canonicalizeCountry("Ireland")).toBe("Ireland");
    expect(canonicalizeCountry("Eire")).toBe("Ireland");
    expect(canonicalizeCountry("Republic of Ireland")).toBe("Ireland");
  });

  it("resolves the remaining tier-one variants", () => {
    expect(canonicalizeCountry("Holland")).toBe("Netherlands");
    expect(canonicalizeCountry("The Netherlands")).toBe("Netherlands");
    expect(canonicalizeCountry("NZ")).toBe("New Zealand");
    expect(canonicalizeCountry("AUS")).toBe("Australia");
  });

  it("returns null for blank input", () => {
    expect(canonicalizeCountry(null)).toBeNull();
    expect(canonicalizeCountry("")).toBeNull();
    expect(canonicalizeCountry("   ")).toBeNull();
  });

  it("passes unrecognised countries through trimmed", () => {
    expect(canonicalizeCountry("  Bulgaria ")).toBe("Bulgaria");
  });
});

describe("isTierOneCountry", () => {
  const tier = DEFAULT_QUALITY_THRESHOLDS.tierOneCountries;

  it("matches through aliases on both sides", () => {
    expect(isTierOneCountry("USA", tier)).toBe(true);
    expect(isTierOneCountry("England", tier)).toBe(true);
    // An admin typing "USA" into the rules editor still matches an account
    // holding the full name.
    expect(isTierOneCountry("United States", ["USA"])).toBe(true);
  });

  it("rejects everything else, including blanks", () => {
    expect(isTierOneCountry("Bulgaria", tier)).toBe(false);
    expect(isTierOneCountry("Germany", tier)).toBe(false);
    expect(isTierOneCountry(null, tier)).toBe(false);
  });
});

// ── Field parsing ────────────────────────────────────────────────────────────

describe("extractYear — Year_Established__c is a free-text field", () => {
  it("reads a plain year", () => {
    expect(extractYear("1974")).toBe(1974);
  });

  it("digs a year out of surrounding text", () => {
    expect(extractYear("Est. 1974")).toBe(1974);
    expect(extractYear("1974-01-01")).toBe(1974);
  });

  it("returns null for blanks and junk", () => {
    expect(extractYear(null)).toBeNull();
    expect(extractYear("")).toBeNull();
    expect(extractYear("unknown")).toBeNull();
  });

  it("rejects implausible years", () => {
    expect(extractYear("1200")).toBeNull();
    expect(extractYear(String(new Date().getFullYear() + 5))).toBeNull();
  });
});

describe("parseYearInput — what a user may type into the fix-it box", () => {
  it("accepts a 4-digit year and returns it as a string", () => {
    expect(parseYearInput("1998")).toBe("1998");
    expect(parseYearInput("  2005 ")).toBe("2005");
  });

  it("rejects junk, wrong lengths, and out-of-range years", () => {
    expect(parseYearInput("abc")).toBeNull();
    expect(parseYearInput("98")).toBeNull();
    expect(parseYearInput("19985")).toBeNull();
    expect(parseYearInput("1799")).toBeNull();
    expect(parseYearInput(String(new Date().getFullYear() + 1))).toBeNull();
    expect(parseYearInput("")).toBeNull();
  });
});

describe("parseEmployeesInput", () => {
  it("accepts whole positive numbers", () => {
    expect(parseEmployeesInput("42")).toBe(42);
    expect(parseEmployeesInput(" 7 ")).toBe(7);
    expect(parseEmployeesInput(120)).toBe(120);
  });

  it("rejects zero, negatives, decimals and junk", () => {
    expect(parseEmployeesInput("0")).toBeNull();
    expect(parseEmployeesInput("-5")).toBeNull();
    expect(parseEmployeesInput("12.5")).toBeNull();
    expect(parseEmployeesInput("lots")).toBeNull();
    expect(parseEmployeesInput("")).toBeNull();
    expect(parseEmployeesInput(null)).toBeNull();
  });
});

describe("parseCountryInput", () => {
  it("accepts trimmed free text", () => {
    expect(parseCountryInput("  Canada ")).toBe("Canada");
  });

  it("rejects blanks and absurd lengths", () => {
    expect(parseCountryInput("")).toBeNull();
    expect(parseCountryInput("   ")).toBeNull();
    expect(parseCountryInput("x".repeat(81))).toBeNull();
  });
});

// ── Scoring ──────────────────────────────────────────────────────────────────

const GOOD: QualityInput = {
  country: "Canada",
  yearEstablished: "1974",
  numberOfEmployees: 80,
};

describe("scoreAccountQuality — two of three makes it BS", () => {
  it("clears a strong target", () => {
    const v = scoreAccountQuality(GOOD);
    expect(v.flags).toEqual([]);
    expect(v.missing).toEqual([]);
    expect(v.isBs).toBe(false);
  });

  it("does NOT call a single flag BS", () => {
    expect(
      scoreAccountQuality({ ...GOOD, country: "Bulgaria" }).isBs,
    ).toBe(false);
    expect(
      scoreAccountQuality({ ...GOOD, yearEstablished: "2023" }).isBs,
    ).toBe(false);
    expect(
      scoreAccountQuality({ ...GOOD, numberOfEmployees: 4 }).isBs,
    ).toBe(false);
  });

  it("calls every two-flag pairing BS", () => {
    const geoAndYoung = scoreAccountQuality({
      ...GOOD,
      country: "Bulgaria",
      yearEstablished: "2023",
    });
    expect(geoAndYoung.isBs).toBe(true);
    expect(geoAndYoung.flags.sort()).toEqual(["founded", "geography"]);

    const geoAndSmall = scoreAccountQuality({
      ...GOOD,
      country: "Bulgaria",
      numberOfEmployees: 4,
    });
    expect(geoAndSmall.isBs).toBe(true);
    expect(geoAndSmall.flags.sort()).toEqual(["employees", "geography"]);

    const youngAndSmall = scoreAccountQuality({
      ...GOOD,
      yearEstablished: "2023",
      numberOfEmployees: 4,
    });
    expect(youngAndSmall.isBs).toBe(true);
    expect(youngAndSmall.flags.sort()).toEqual(["employees", "founded"]);
  });

  it("calls all three BS", () => {
    const v = scoreAccountQuality({
      country: "Bulgaria",
      yearEstablished: "2023",
      numberOfEmployees: 4,
    });
    expect(v.flags).toHaveLength(3);
    expect(v.isBs).toBe(true);
  });
});

describe("scoreAccountQuality — threshold boundaries", () => {
  it("treats the founded cutoff year itself as fine", () => {
    // "Founded after 2019" → 2019 is fine, 2020 is not.
    expect(
      scoreAccountQuality({ ...GOOD, yearEstablished: "2019" }).flags,
    ).toEqual([]);
    expect(
      scoreAccountQuality({ ...GOOD, yearEstablished: "2020" }).flags,
    ).toEqual(["founded"]);
  });

  it("treats exactly the minimum headcount as fine", () => {
    // "Fewer than 15 is suspicious" → 15 is fine, 14 is not.
    expect(
      scoreAccountQuality({ ...GOOD, numberOfEmployees: 15 }).flags,
    ).toEqual([]);
    expect(
      scoreAccountQuality({ ...GOOD, numberOfEmployees: 14 }).flags,
    ).toEqual(["employees"]);
  });

  it("honours custom thresholds", () => {
    const strict = {
      ...DEFAULT_QUALITY_THRESHOLDS,
      foundedAfterYear: 2000,
      minEmployees: 100,
    };
    const v = scoreAccountQuality(
      { country: "Canada", yearEstablished: "2005", numberOfEmployees: 80 },
      strict,
    );
    expect(v.flags.sort()).toEqual(["employees", "founded"]);
    expect(v.isBs).toBe(true);
  });
});

describe("scoreAccountQuality — blank fields", () => {
  it("counts blanks as flags AND records them as missing", () => {
    const v = scoreAccountQuality({
      country: null,
      yearEstablished: null,
      numberOfEmployees: null,
    });
    expect(v.flags.sort()).toEqual(["employees", "founded", "geography"]);
    expect(v.missing.sort()).toEqual(["employees", "founded", "geography"]);
    expect(v.isBs).toBe(true);
  });

  it("separates a bad value from a blank one", () => {
    const v = scoreAccountQuality({
      country: "Bulgaria", // a real, bad value
      yearEstablished: null, // not filled in
      numberOfEmployees: 80,
    });
    expect(v.flags.sort()).toEqual(["founded", "geography"]);
    expect(v.missing).toEqual(["founded"]);
    expect(v.isBs).toBe(true);
  });

  it("treats a stored headcount of 0 as unknown, not as a real value", () => {
    const v = scoreAccountQuality({ ...GOOD, numberOfEmployees: 0 });
    expect(v.flags).toEqual(["employees"]);
    expect(v.missing).toEqual(["employees"]);
  });
});

describe("scoreAccountQuality — the near-100% regression guard", () => {
  it("skips the founded criterion entirely when the SF field is absent", () => {
    // If Year_Established__c is missing from the org the SOQL fallback drops
    // it, every row arrives blank, and scoring it as "missing" would flag the
    // whole team at ~100%. It must be ignored instead.
    const v = scoreAccountQuality(
      { country: "Canada", yearEstablished: null, numberOfEmployees: 80 },
      DEFAULT_QUALITY_THRESHOLDS,
      { foundedFieldAvailable: false },
    );
    expect(v.flags).toEqual([]);
    expect(v.missing).toEqual([]);
    expect(v.isBs).toBe(false);
  });

  it("still needs two of the remaining two signals to call BS", () => {
    const v = scoreAccountQuality(
      { country: "Bulgaria", yearEstablished: null, numberOfEmployees: 4 },
      DEFAULT_QUALITY_THRESHOLDS,
      { foundedFieldAvailable: false },
    );
    expect(v.flags.sort()).toEqual(["employees", "geography"]);
    expect(v.isBs).toBe(true);
  });
});

// ── Aggregation ──────────────────────────────────────────────────────────────

const BUCKETS = [
  { label: "Aug 3", start: "2026-08-03", end: "2026-08-09" },
  { label: "Aug 10", start: "2026-08-10", end: "2026-08-16" },
];

function row(
  overrides: Partial<ScorableOutreachRow> = {},
): ScorableOutreachRow {
  return {
    activityDate: "2026-08-05",
    owner: "Nate Sabb",
    country: "Canada",
    yearEstablished: "1974",
    numberOfEmployees: 80,
    ...overrides,
  };
}

const BS_FIELDS = { country: "Bulgaria", numberOfEmployees: 3 };

describe("aggregateOutreachQuality", () => {
  it("counts totals and the overall rate", () => {
    const agg = aggregateOutreachQuality(
      [row(), row(), row(BS_FIELDS), row(BS_FIELDS)],
      BUCKETS,
    );
    expect(agg.totals.sent).toBe(4);
    expect(agg.totals.bs).toBe(2);
    expect(agg.totals.rate).toBeCloseTo(0.5);
  });

  it("assigns rows to buckets, including on a boundary date", () => {
    const agg = aggregateOutreachQuality(
      [
        row({ activityDate: "2026-08-03" }), // first day of bucket 1
        row({ activityDate: "2026-08-09", ...BS_FIELDS }), // last day of bucket 1
        row({ activityDate: "2026-08-10" }), // first day of bucket 2
        row({ activityDate: "2026-08-16", ...BS_FIELDS }), // last day of bucket 2
      ],
      BUCKETS,
    );
    expect(agg.byBucket[0]).toMatchObject({ label: "Aug 3", sent: 2, bs: 1 });
    expect(agg.byBucket[1]).toMatchObject({ label: "Aug 10", sent: 2, bs: 1 });
  });

  it("keeps rows outside every bucket out of the buckets but in the totals", () => {
    const agg = aggregateOutreachQuality(
      [row({ activityDate: "2026-07-01" })],
      BUCKETS,
    );
    expect(agg.totals.sent).toBe(1);
    expect(agg.byBucket[0].sent).toBe(0);
    expect(agg.byBucket[1].sent).toBe(0);
  });

  it("breaks down by sender, worst rate first", () => {
    const agg = aggregateOutreachQuality(
      [
        row({ owner: "Clean Colleague" }),
        row({ owner: "Clean Colleague" }),
        row({ owner: "Sloppy Colleague", ...BS_FIELDS }),
        row({ owner: "Sloppy Colleague", ...BS_FIELDS }),
      ],
      BUCKETS,
    );
    expect(agg.byPerson[0]).toMatchObject({
      owner: "Sloppy Colleague",
      sent: 2,
      bs: 2,
      rate: 1,
    });
    expect(agg.byPerson[1]).toMatchObject({
      owner: "Clean Colleague",
      bs: 0,
      rate: 0,
    });
  });

  it("counts reasons across BS rows only", () => {
    const agg = aggregateOutreachQuality(
      [
        row({ country: "Bulgaria" }), // 1 flag → not BS, must not be counted
        row({ country: "Bulgaria", numberOfEmployees: 3 }), // geo + headcount
        row({ yearEstablished: "2024", numberOfEmployees: 3 }), // founded + headcount
      ],
      BUCKETS,
    );
    expect(agg.totals.bs).toBe(2);
    expect(agg.reasonCounts).toEqual({
      geography: 1,
      founded: 1,
      employees: 2,
    });
    // Reasons exceed the BS count because each BS email cites 2+ of them.
    const cited =
      agg.reasonCounts.geography +
      agg.reasonCounts.founded +
      agg.reasonCounts.employees;
    expect(cited).toBeGreaterThan(agg.totals.bs);
  });

  it("reports a rate of 0 rather than NaN when nothing was sent", () => {
    const agg = aggregateOutreachQuality([], BUCKETS);
    expect(agg.totals.rate).toBe(0);
    expect(agg.byBucket.every((b) => b.rate === 0)).toBe(true);
    expect(agg.byPerson).toEqual([]);
  });

  it("propagates foundedFieldAvailable into the scoring", () => {
    const rows = [row({ yearEstablished: null, numberOfEmployees: 3 })];
    // With the field present: founded (blank) + headcount = BS.
    expect(aggregateOutreachQuality(rows, BUCKETS).totals.bs).toBe(1);
    // With the field absent: headcount alone is not enough.
    const agg = aggregateOutreachQuality(
      rows,
      BUCKETS,
      DEFAULT_QUALITY_THRESHOLDS,
      false,
    );
    expect(agg.totals.bs).toBe(0);
    expect(agg.foundedFieldAvailable).toBe(false);
  });
});

// ── Threshold coercion ───────────────────────────────────────────────────────

describe("coerceQualityThresholds — a bad settings row must not break Stats", () => {
  it("returns defaults for null, junk and wrong types", () => {
    expect(coerceQualityThresholds(null)).toEqual(DEFAULT_QUALITY_THRESHOLDS);
    expect(coerceQualityThresholds("nope")).toEqual(DEFAULT_QUALITY_THRESHOLDS);
    expect(
      coerceQualityThresholds({
        tierOneCountries: "Canada",
        foundedAfterYear: "2019",
        minEmployees: null,
        bsFlagCount: {},
      }),
    ).toEqual(DEFAULT_QUALITY_THRESHOLDS);
  });

  it("accepts a valid override", () => {
    expect(
      coerceQualityThresholds({
        tierOneCountries: ["Canada", "United States"],
        foundedAfterYear: 2015,
        minEmployees: 25,
        bsFlagCount: 3,
      }),
    ).toEqual({
      tierOneCountries: ["Canada", "United States"],
      foundedAfterYear: 2015,
      minEmployees: 25,
      bsFlagCount: 3,
    });
  });

  it("falls back on an empty country list, which would flag everything", () => {
    const t = coerceQualityThresholds({ tierOneCountries: [] });
    expect(t.tierOneCountries).toEqual(DEFAULT_QUALITY_THRESHOLDS.tierOneCountries);
  });

  it("rejects out-of-range numbers field by field", () => {
    const t = coerceQualityThresholds({
      tierOneCountries: ["Canada"],
      foundedAfterYear: 1500,
      minEmployees: -3,
      bsFlagCount: 9,
    });
    expect(t.tierOneCountries).toEqual(["Canada"]);
    expect(t.foundedAfterYear).toBe(DEFAULT_QUALITY_THRESHOLDS.foundedAfterYear);
    expect(t.minEmployees).toBe(DEFAULT_QUALITY_THRESHOLDS.minEmployees);
    expect(t.bsFlagCount).toBe(DEFAULT_QUALITY_THRESHOLDS.bsFlagCount);
  });

  it("drops blank and absurd country entries", () => {
    const t = coerceQualityThresholds({
      tierOneCountries: ["Canada", "  ", "x".repeat(90), " Ireland "],
    });
    expect(t.tierOneCountries).toEqual(["Canada", "Ireland"]);
  });
});
