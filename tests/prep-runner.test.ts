import { describe, expect, it } from "vitest";
import { parseSections, pickHistory, thinSections } from "../lib/jobs/prep-runner";

const FULL = `COMPANY NAME: MachineMetrics
WHAT THEY DO:
MachineMetrics sells software that connects to factory machines and shows what they are doing right now. ${"It pulls data from machines, old and new. ".repeat(8)}
CUSTOMERS:
Buyers are discrete manufacturers with CNC shops. ${"They buy because downtime is expensive. ".repeat(12)} For example, imagine a shop foreman at 6am. ${"He opens the app and sees the machine. ".repeat(6)}
COMPANY HISTORY:
Founded in 2014 in Northampton, Massachusetts. ${"The company grew through the decade. ".repeat(8)}
RECENT NEWS:
- September 2026: introduced MaximaOS at IMTS.
- None of this is "quoted" oddly: it's fine.
`;

describe("parseSections", () => {
  it("reads labelled sections, including quotes and line breaks inside them", () => {
    const p = parseSections(FULL);
    expect(p.companyName).toBe("MachineMetrics");
    expect(p.whatTheyDo.startsWith("MachineMetrics sells software")).toBe(true);
    expect(p.customers).toContain("For example, imagine");
    expect(p.recentNews).toHaveLength(2);
    expect(p.recentNews[0]).toBe("September 2026: introduced MaximaOS at IMTS.");
    expect(thinSections(p, "first_call")).toEqual([]);
  });
  it("tolerates markdown headings and strips cite tags", () => {
    const p = parseSections("## WHAT THEY DO:\n<cite index='1-2'>Makes software.</cite>\n**CUSTOMERS:** Shops.\nRECENT NEWS:\nNone");
    expect(p.whatTheyDo).toBe("Makes software.");
    expect(p.customers).toBe("Shops.");
    expect(p.recentNews).toEqual([]);
  });
  it("names the sections that are missing or cut short", () => {
    const p = parseSections("COMPANY NAME: X\nWHAT THEY DO:\nOn top of that data, it runs scheduling, work orders, labor t\nCUSTOMERS:\nCOMPANY HISTORY:\nRECENT NEWS:\nNone");
    expect(thinSections(p, "first_call")).toEqual(["whatTheyDo", "customers", "companyHistory"]);
  });
});

describe("parseSections tolerates heading variants", () => {
  it("reads headings without a colon and with longer labels", () => {
    const raw = `COMPANY NAME
TireCheck

WHAT THEY DO
TireCheck sells software to tyre shops.

CUSTOMERS & USE CASE:
Independent tyre dealers.

COMPANY HISTORY
Founded in 2004.

RELATIONSHIP CATCH-UP
Not available.

RECENT NEWS
- Launched a new app, Mar 2026.`;
    const c = parseSections(raw);
    expect(c.companyName).toBe("TireCheck");
    expect(c.whatTheyDo).toBe("TireCheck sells software to tyre shops.");
    expect(c.customers).toBe("Independent tyre dealers.");
    expect(c.companyHistory).toBe("Founded in 2004.");
    expect(c.relationshipCatchUp).toBe("Not available.");
    expect(c.recentNews).toEqual(["Launched a new app, Mar 2026."]);
  });
  it("does not treat a label inside a sentence as a heading", () => {
    const c = parseSections("WHAT THEY DO:\nThey sell to customers who need it. Customers are mostly dealers.\nCUSTOMERS:\nDealers.");
    expect(c.whatTheyDo).toContain("Customers are mostly dealers.");
    expect(c.customers).toBe("Dealers.");
  });
});

describe("company history from web search", () => {
  const researched = `COMPANY HISTORY:
Acme Controls was founded in 2009 in Minneapolis, Minnesota, by two engineers from the embedded systems world. It launched Relay, its industrial IoT platform, in 2016 and later added Watch as a white-label monitoring app built on it. The company is privately held and led by its founders. It sells to equipment makers who want to offer connected products without building the cloud side themselves, and has partnered with chip and gateway vendors to make devices ready out of the box.
RECENT NEWS:
- March 2026: released a new Watch version with predictive alerts.`;

  it("reads the researched history and news", () => {
    const p = parseSections(researched);
    expect(p.companyHistory.startsWith("Acme Controls was founded in 2009")).toBe(true);
    expect(p.recentNews).toHaveLength(1);
  });
  it("prefers the researched history over the website-only one", () => {
    const website = "The founding year, founders, and ownership are not available in the supplied evidence.";
    expect(pickHistory(website, parseSections(researched).companyHistory)).toContain("founded in 2009");
  });
  it("falls back to the website history when the search came back empty", () => {
    expect(pickHistory("Founded in 2014 in Northampton.", "")).toBe("Founded in 2014 in Northampton.");
    expect(pickHistory("Founded in 2014 in Northampton.", "Not available")).toBe("Founded in 2014 in Northampton.");
  });
});
