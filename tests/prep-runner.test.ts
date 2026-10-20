import { describe, expect, it } from "vitest";
import { parseSections, thinSections } from "../lib/jobs/prep-runner";

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
