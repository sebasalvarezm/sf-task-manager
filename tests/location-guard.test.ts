import { describe, expect, it } from "vitest";
import { looksLikeAddress, looksLikeTown } from "../lib/location-guard";

describe("looksLikeAddress", () => {
  it("accepts real addresses and city/region pairs", () => {
    for (const ok of [
      "123 Main St, Denver, CO 80202",
      "11340 Lakefield Dr, Johns Creek, GA 30097, USA",
      "Wethouder Jansenlaan 78, Harderwijk, 3844 DG, Netherlands",
      "Reno, NV",
      "Bel Air, MD",
      "Toronto, ON",
      "Tampa, Florida",
      "1 Rue de la Paix, Paris, France",
      "Suite 400, 200 Bay Street, Toronto, ON M5J 2J2",
      "Perth, Australia",
    ]) {
      expect(looksLikeAddress(ok), ok).toBe(true);
    }
  });
  it("rejects model narration, even with digits in a company name", () => {
    for (const bad of [
      "I'll search for Route4Me's headquarters using multiple queries simultaneously.",
      "Let me search for the headquarters of Track'em.",
      "Based on the search results, the company appears to be located in Tampa.",
      "I cannot find a location for this company.",
      "The company is headquartered in Austin, TX according to their website",
      "Here is the address: unknown",
      "null",
      "Searching for BargeOps HQ",
      "Route4Me",
    ]) {
      expect(looksLikeAddress(bad), bad).toBe(false);
    }
  });
});

describe("looksLikeTown", () => {
  it("accepts towns", () => {
    for (const ok of ["Tampa", "Tampa, FL", "Johns Creek", "St. Louis", "Rolling Meadows", "Creve Coeur", "Harderwijk", "Rio de Janeiro", "Stratford-upon-Avon", "Montréal"]) {
      expect(looksLikeTown(ok), ok).toBe(true);
    }
  });
  it("rejects narration, digits and long text", () => {
    for (const bad of [
      "I'll search for Route4Me's headquarters using multiple queries simultaneously.",
      "the company",
      "Tampa 33602",
      "unknown location, please verify",
      "found in Tampa",
      "A polished classic American steakhouse in Tampa",
      "",
    ]) {
      expect(looksLikeTown(bad), bad).toBe(false);
    }
  });
});
