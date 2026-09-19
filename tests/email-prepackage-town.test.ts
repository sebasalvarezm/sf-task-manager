import { describe, expect, it } from "vitest";
import { buildPrepackagedEmail } from "../lib/email-prepackage";

const base = {
  mainGroup: "Logistics",
  subgroup: "Freight Supply Chain Enablement",
  emailHook: "I have studied Route4me going back to the days of the Batch Geocoder.",
  outreachParagraph: "Route4Me lives right in the heart of this.",
  restaurants: [{ name: "Bern's Steak House", description: "Tampa institution" }],
  now: new Date("2026-09-19T12:00:00"),
};

describe("buildPrepackagedEmail town guard", () => {
  it("never puts model narration into the email", () => {
    const out = buildPrepackagedEmail({
      ...base,
      address: "I'll search for Route4Me's headquarters using multiple queries simultaneously.",
      locationConfidence: "city",
    });
    if (out.skipped) return; // template missing in this environment
    expect(out.body).not.toMatch(/search for|queries|simultaneously/i);
    expect(out.body).toContain("[INSERT TOWN]");
    expect(out.warnings.join(" ")).toMatch(/did not look like a real town/);
  });
  it("still fills a real town", () => {
    const out = buildPrepackagedEmail({
      ...base,
      address: "4409 W Kennedy Blvd, Tampa, FL 33609",
      locationConfidence: "exact",
    });
    if (out.skipped) return;
    expect(out.body).toMatch(/near Tampa on the/);
    expect(out.body).not.toContain("[INSERT TOWN]");
  });
});
