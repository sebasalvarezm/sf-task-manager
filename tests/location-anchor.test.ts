import { describe, expect, it } from "vitest";
import { addressInCity, needsAnchor, salesforceAddress } from "../lib/location-anchor";
import { buildPrepackagedEmail } from "../lib/email-prepackage";

describe("town follows Salesforce", () => {
  const mcs = { city: "White Waltham", state: "Berkshire", country: "United Kingdom" };
  it("replaces a website office in another country with the Salesforce city", () => {
    expect(needsAnchor({ address: "Route du Jura 37, CH-1700 Fribourg, Switzerland" }, mcs)).toBe("White Waltham, United Kingdom");
  });
  it("keeps a website address in the same city (street level is better for restaurants)", () => {
    expect(needsAnchor({ address: "Shottesbrooke Park, White Waltham, Maidenhead SL6 3SR, UK" }, mcs)).toBeNull();
    expect(addressInCity("1200 Rue Peel, Montréal, QC", "Montreal")).toBe(true);
    expect(addressInCity("10 Main St, St. Laurent, QC", "Saint-Laurent")).toBe(true);
  });
  it("leaves the result alone when Salesforce has no usable city", () => {
    expect(needsAnchor({ address: "Fribourg, Switzerland" }, { city: null, state: null, country: "United Kingdom" })).toBeNull();
    expect(needsAnchor({ address: "Fribourg, Switzerland" }, { city: "12345", state: null, country: null })).toBeNull();
  });
  it("keeps US state codes and drops long county names", () => {
    expect(salesforceAddress({ city: "Atlanta", state: "GA", country: "United States" })).toBe("Atlanta, GA, United States");
    expect(salesforceAddress(mcs)).toBe("White Waltham, United Kingdom");
  });
  it("puts the Salesforce town in the email", () => {
    const email = buildPrepackagedEmail({ companyName: "MCS", mainGroup: "Logistics", subgroup: "Freight Supply Chain Enablement", emailHook: null, outreachParagraph: null, address: "White Waltham, United Kingdom", locationConfidence: "city", restaurants: [{ name: "The Beehive", description: "" }], now: new Date("2026-10-27T12:00:00Z") });
    expect(JSON.stringify(email)).toContain("near White Waltham");
  });
});
