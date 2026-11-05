import { describe, expect, it } from "vitest";
import {
  buildRceFollowUp,
  daysBetween,
  firstNameFrom,
  firstNameFromGreeting,
  followUpCloser,
  greetingName,
  pickTemplateIndex,
} from "../lib/rce-followup";

describe("rce follow-up", () => {
  it("fills the first name and signs off as Seb", () => {
    const { body, usedPlaceholder } = buildRceFollowUp({
      seed: "a",
      firstName: "Charles",
      now: new Date("2026-09-22T10:00:00"), // Tuesday
      templateIndex: 0,
    });
    expect(body).toBe(
      "Charles,\n\nFollowing up once more. Would love to discuss a potential acquisition.\n\nBest,\nSeb",
    );
    expect(usedPlaceholder).toBe(false);
  });
  it("uses the weekend closer on Friday only, Montreal time", () => {
    expect(followUpCloser(new Date("2026-09-24T14:00:00Z"))).toBe("Best,"); // Thu
    expect(followUpCloser(new Date("2026-09-25T14:00:00Z"))).toBe("Have a great weekend,"); // Fri
    expect(followUpCloser(new Date("2026-09-21T14:00:00Z"))).toBe("Best,"); // Mon
    expect(followUpCloser(new Date("2026-09-26T14:00:00Z"))).toBe("Best,"); // Sat
    // Thursday 9pm in Montreal is already Friday on the server (UTC): still Thursday for Seb.
    expect(followUpCloser(new Date("2026-11-06T02:00:00Z"))).toBe("Best,");
  });
  it("the Weekly Outreach follow-up is a plain second email", () => {
    const { body } = buildRceFollowUp({ seed: "anything", firstName: "Kristen", now: new Date("2026-11-05T15:00:00Z"), kind: "second" }); // Thursday
    expect(body).toBe("Hi Kristen,\n\nFollowing up on my last email. Are you available to catch-up and resume acquisition discussions in the next week or two?\n\nBest,\nSeb");
    expect(body).not.toMatch(/final time|once more/i);
  });
  it("falls back to a visible placeholder when the first name is unknown", () => {
    const { body, usedPlaceholder } = buildRceFollowUp({
      seed: "x", firstName: null, now: new Date("2026-09-22T10:00:00"), templateIndex: 1,
    });
    expect(body.startsWith("Hi [First name],")).toBe(true);
    expect(usedPlaceholder).toBe(true);
  });
  it("never contains filler", () => {
    for (let i = 0; i < 3; i++) {
      const { body } = buildRceFollowUp({ seed: "s", firstName: "Terry", now: new Date(), templateIndex: i });
      expect(body).not.toMatch(/hope this|circle back|touch base|kindly|at your earliest/i);
      expect(body.split("\n").filter(Boolean).length).toBeLessThanOrEqual(5);
    }
  });
  it("extracts first names from display names and greetings", () => {
    expect(firstNameFrom("Charles Smith")).toBe("Charles");
    expect(firstNameFrom("Smith, Charles")).toBe("Charles");
    expect(firstNameFrom("charles@acme.com")).toBeNull();
    expect(firstNameFrom("")).toBeNull();
    expect(firstNameFromGreeting("Hi Charles,\n\nFollowing up...")).toBe("Charles");
    expect(firstNameFromGreeting("Terry, quickly following up")).toBe("Terry");
    expect(firstNameFromGreeting("Dear Mr. Lee,")).toBe("Lee");
    expect(firstNameFromGreeting("Following up on the MNDA.")).toBeNull();
  });
  it("picks templates deterministically", () => {
    expect(pickTemplateIndex("row-1")).toBe(pickTemplateIndex("row-1"));
    expect(pickTemplateIndex("row-1", 3)).toBeLessThan(3);
  });
  it("counts whole days", () => {
    expect(daysBetween("2026-09-19T15:00:00Z", new Date("2026-09-22T10:00:00Z"))).toBe(2);
    expect(daysBetween("garbage", new Date())).toBe(0);
  });
});

describe("greetingName", () => {
  it("takes the first name from the From header, or from a firstname.lastname address", () => {
    expect(greetingName("Somnath Deb", "deb@teamqsi.com")).toBe("Somnath");
    expect(greetingName("Deb, Somnath", "deb@teamqsi.com")).toBe("Somnath");
    expect(greetingName("", "fearghal.murphy@wiswm.com")).toBe("Fearghal");
    expect(greetingName("", "deb@teamqsi.com")).toBeNull();
    expect(greetingName("Sales Team", "sales@acme.com")).toBeNull();
  });
});
