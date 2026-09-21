import { describe, expect, it } from "vitest";
import {
  buildRceFollowUp,
  daysBetween,
  firstNameFrom,
  firstNameFromGreeting,
  followUpCloser,
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
  it("uses the weekend closer on Thursday and Friday only", () => {
    expect(followUpCloser(new Date("2026-09-24T10:00:00"))).toBe("Have a great weekend,"); // Thu
    expect(followUpCloser(new Date("2026-09-25T10:00:00"))).toBe("Have a great weekend,"); // Fri
    expect(followUpCloser(new Date("2026-09-21T10:00:00"))).toBe("Best,"); // Mon
    expect(followUpCloser(new Date("2026-09-26T10:00:00"))).toBe("Best,"); // Sat
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
