import { describe, expect, it } from "vitest";
import { findLinkedInCompanyUrl, formatExcluded } from "../lib/outreach-screen";
import { stripCites } from "../lib/anthropic";

describe("LinkedIn company page from site text", () => {
  it("finds a company page in Jina markdown", () => {
    const text = "Follow us [LinkedIn](https://www.linkedin.com/company/tronia-systems/) and [Twitter](https://x.com/tronia)";
    expect(findLinkedInCompanyUrl(text)).toBe("https://www.linkedin.com/company/tronia-systems");
  });
  it("accepts regional hosts and upgrades http", () => {
    expect(findLinkedInCompanyUrl("http://ca.linkedin.com/company/acme")).toBe("https://ca.linkedin.com/company/acme");
  });
  it("ignores personal profiles", () => {
    expect(findLinkedInCompanyUrl("https://www.linkedin.com/in/dave-owner")).toBeNull();
  });
});

describe("LinkedIn lookup reply parsing", () => {
  it("pulls the company URL out of a chatty reply and strips tracking", () => {
    expect(findLinkedInCompanyUrl("The page is https://www.linkedin.com/company/tronia-systems/?trk=foo for Tronia.")).toBe("https://www.linkedin.com/company/tronia-systems");
  });
});

describe("formatExcluded", () => {
  it("turns Seb's wrong-market skips into one example line each, without repeats", () => {
    const text = formatExcluded([
      { account_name: "Acme Dental", skip_reason: "Wrong end market: dental labs", screen_facts: { softwareType: "lab scheduling" } },
      { account_name: "Acme Dental", skip_reason: "Wrong end market: dental labs", screen_facts: { softwareType: "lab scheduling" } },
      { account_name: "Church Hub", skip_reason: "Wrong end market", screen_facts: null },
    ]);
    expect(text).toBe("- Acme Dental (lab scheduling): dental labs\n- Church Hub");
  });
});

describe("stripCites", () => {
  it("removes the search tool's cite tags and nothing else", () => {
    expect(stripCites("<cite index='7-1'>Ecochain makes software.</cite> <cite index='6-5'>Two products.</cite>")).toBe("Ecochain makes software. Two products.");
    expect(stripCites("plain text")).toBe("plain text");
  });
});
