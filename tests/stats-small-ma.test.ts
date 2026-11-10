import { describe, expect, it } from "vitest";
import { TEAM_CONFIG, SMALL_MA_OWNER_NAMES } from "@/lib/salesforce-stats";

describe("Small M&A pipeline", () => {
  it("counts small deals from anyone, plus any deal a team member originated", () => {
    const clause = TEAM_CONFIG.small_ma.pipelineClause;
    for (const n of SMALL_MA_OWNER_NAMES) expect(clause).toContain(`'${n}'`);
    expect(clause.startsWith("(Amount <= 8000 OR Owner.Name IN (")).toBe(true);
    expect(clause.endsWith("))")).toBe(true); // wrapped, so "AND <clause>" can't leak
  });
  it("leaves CDM alone", () => {
    expect(TEAM_CONFIG.cdm.pipelineClause).toBe("Account.Group__c = 'CDM'");
  });
});
