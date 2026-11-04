import { describe, expect, it } from "vitest";
import { canonicalSubgroup, findGroupFileName, loadGroupFiles } from "@/lib/scout";
import { matchSequence } from "@/lib/e1-sends";
import { buildPrepackagedEmail } from "@/lib/email-prepackage";
import type { OutreachSequence } from "@/lib/outreach";

const groups = loadGroupFiles();
const subgroupNames = Object.keys(groups)
  .filter((k) => k.includes("/"))
  .map((k) => canonicalSubgroup(k, groups)!);

// The enabled [E] sequences in Outreach on Nov 4, 2026 (read-only from the live account).
const LIVE: string[] = [
  "[E] - Agriculture — Fresh Produce", "[E] - Agriculture — Grain & Crop", "[E] - Agriculture — Protein & Livestock",
  "[E] - Bulk Liquids", "[E] - Bulk Materials", "[E] - Contractor", "[E] - Equipment", "[E] - Forest & Lumber", "[E] - Mining",
  "[E] - Safety & Compliance", "[E] - Structure Design/Analysis", "[E] - Waste",
  "[E] - Logistics — Freight & Supply Chain Enablement ", "[E] - Logistics — Industrial Gate & Yard", "[E] - Logistics — Maritime",
  "[E] - Logistics — Rail", "[E] - Manufacturing — Aftermarket & Service", "[E] - Manufacturing — Engineering & Estimating ",
  "[E] - Manufacturing → Process Manufacturing", "[E] - Manufacturing → Production Quality",
];
const sequences = LIVE.map((name, i) => ({ id: String(i + 1), name, enabled: true }) as unknown as OutreachSequence);

describe("subgroups are exactly the 20 group files", () => {
  it("never turns a Salesforce label into a subgroup", () => {
    for (const label of ["Ag", "CDM", "Transport & Logistics", "Food Processing", "Manufacturing", "Agriculture", "Logistics", ""]) {
      expect(findGroupFileName(label, groups)).toBeNull();
      expect(canonicalSubgroup(label, groups)).toBeNull();
    }
  });
  it("accepts the real names in every spelling Sourcing and Discovery use", () => {
    expect(canonicalSubgroup("Grain Crop", groups)).toBe("Grain Crop");
    expect(canonicalSubgroup("Safety & Compliance", groups)).toBe("Safety Compliance");
    expect(canonicalSubgroup("Agriculture/grain-crop.md", groups)).toBe("Grain Crop");
    expect(canonicalSubgroup("Structure Design/Analysis", groups)).toBe("Structure Design Analysis");
  });
  it("every subgroup has an enabled [E] sequence and an email template", () => {
    expect(subgroupNames).toHaveLength(20);
    for (const name of subgroupNames) {
      expect(matchSequence(name, sequences, {}), name).not.toBeNull();
      const key = findGroupFileName(name, groups)!;
      const email = buildPrepackagedEmail({
        companyName: "Acme", mainGroup: key.split("/")[0], subgroup: name, emailHook: "I have studied Acme going back to 2001.",
        outreachParagraph: null, address: "Story City, Iowa, United States", locationConfidence: "city", restaurants: [], now: new Date("2026-11-04T12:00:00Z"),
      });
      expect(email.skipped, `${name}: ${email.skipReason}`).toBe(false);
    }
  });
});
