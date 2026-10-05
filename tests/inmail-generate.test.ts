import { describe, expect, it } from "vitest";
import {
  extractHookSentence,
  firstNameOf,
  followUpTemplate,
  recruiterSearchUrl,
  linkedInPeopleSearchUrl,
  normalizeInMail,
  parseInMailJson,
  validateInitialInMail,
} from "../lib/inmail-generate";

const e1 = `Hi Charles,

I have studied Cargosnap going back to the days of the first damage-claim app. My name is Nate, and I lead investment efforts at Valstone. We are a global provider of mission-critical software, focused on industrial end markets where operations rely on reliable systems every day.

We are building a dedicated Freight and Supply Chain Enablement group. In simple terms, we help operators plan, move, store, and source.

I will be near Rotterdam in the second week of October and would love to discuss at your office. Please let me know if available.

Best,
Nate`;

const good = `Charles, I sent you a few emails recently but wanted to try here as well. I have studied Cargosnap going back to the days of the first damage-claim app. I lead investment efforts at Valstone. We are a global provider of mission-critical software focused on industrial end markets.

We are building a dedicated Freight and Supply Chain Enablement group, a long-term home for software from transportation management through to yard and workforce coordination.

Would love to find time to discuss, as I am planning to be near Rotterdam in a few weeks. Happy to work around your schedule.

Best,
Seb`;

describe("inmail generation guards", () => {
  it("extracts the hook sentence", () => {
    expect(extractHookSentence(e1)).toBe(
      "I have studied Cargosnap going back to the days of the first damage-claim app.",
    );
  });
  it("accepts a clean InMail", () => {
    expect(validateInitialInMail({ text: good, firstName: "Charles", e1Body: e1 })).toEqual([]);
  });
  it("flags the usual drift", () => {
    const bad = good
      .replace("Charles, I sent you a few emails recently but wanted to try here as well.", "Hi Charles, hope this finds you well.")
      .replace("Best,\nSeb", "Best,\nNate")
      .replace("a long-term home", "a long-term home — leverage our platform")
      + "\n\nIn simple terms, we help.";
    const problems = validateInitialInMail({ text: bad, firstName: "Charles", e1Body: e1 });
    expect(problems.join(" | ")).toMatch(/Opening line/);
    expect(problems.join(" | ")).toMatch(/dash/);
    expect(problems.join(" | ")).toMatch(/leverage/);
    expect(problems.join(" | ")).toMatch(/sender name/);
    expect(problems.join(" | ")).toMatch(/in simple terms/);
  });
  it("flags a changed hook", () => {
    const changed = good.replace("the days of the first damage-claim app", "its early days");
    expect(validateInitialInMail({ text: changed, firstName: "Charles", e1Body: e1 }).join(" ")).toMatch(/hook/);
  });
  it("normalizes dashes, hyphenation and the signature", () => {
    expect(normalizeInMail("mission critical — long term home\n\nBest,\nNate")).toBe(
      "mission-critical, long-term home\n\nBest,\nSeb",
    );
  });
  it("parses JSON with fences and prose", () => {
    const parsed = parseInMailJson('Here you go:\n```json\n{"initial":"A","followup":"B"}\n```');
    expect(parsed).toEqual({ initial: "A", followup: "B" });
    expect(parseInMailJson("nope")).toBeNull();
  });
  it("builds the follow-up and links", () => {
    expect(followUpTemplate("Charles")).toContain("Charles, just following up on my earlier message.");
    expect(firstNameOf("Charles de Smet")).toBe("Charles");
    expect(firstNameOf(null)).toBeNull();
    expect(recruiterSearchUrl("Charles de Smet", "Cargosnap")).toBe(
      "https://www.linkedin.com/talent/search?keywords=Charles%20de%20Smet%20Cargosnap",
    );
    expect(linkedInPeopleSearchUrl("Charles de Smet", "Cargosnap")).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=Charles%20de%20Smet%20Cargosnap",
    );
  });
});

import { inmailSubject } from "../lib/inmail-generate";

describe("inmailSubject", () => {
  it("is short and specific", () => {
    expect(inmailSubject("Cargosnap")).toBe("Valstone / Cargosnap");
    expect(inmailSubject("  ")).toBe("Valstone");
    expect(inmailSubject(null)).toBe("Valstone");
  });
});
