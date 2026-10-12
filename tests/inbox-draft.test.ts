import { describe, expect, it } from "vitest";
import { fallbackDraft, firstNameOfSender, normalizeDraft, validateDraft } from "../lib/inbox-draft";

describe("inbox drafts", () => {
  it("finds the first name from odd display names", () => {
    expect(firstNameOfSender("Niko Zorkin", "nzorkin@enkon.com")).toBe("Niko");
    expect(firstNameOfSender("Tim Bethlehem | Extendas", "tim@extendas.com")).toBe("Tim");
    expect(firstNameOfSender("Zorkin, Niko", null)).toBe("Niko");
    expect(firstNameOfSender("", "ravi.ahuja@optym.com")).toBe("Ravi");
  });
  it("normalises dashes and thanks", () => {
    expect(normalizeDraft("Hi Niko,\n\nUnderstood — thanks for the reply.\n\nBest,\nSebastian")).toBe("Hi Niko,\n\nUnderstood, thank you for the reply.\n\nBest,\nSebastian");
  });
  it("flags banned phrases and a missing sign-off", () => {
    const issues = validateDraft("Hi Niko,\n\nLet's touch base in Q2.\n\nCheers", 200);
    expect(issues.some((i) => /touch base/.test(i))).toBe(true);
    expect(issues.some((i) => /end with/.test(i))).toBe(true);
  });
  it("accepts a clean draft", () => {
    expect(validateDraft(fallbackDraft("neutral", "Niko", "six months or so"), 300)).toEqual([]);
    expect(validateDraft(fallbackDraft("negative", "Scott", null), 100)).toEqual([]);
  });
});

describe("positive replies", () => {
  it("follows Seb's structure with no detail", async () => {
    const { positiveDraft } = await import("../lib/inbox-draft");
    expect(positiveDraft("Michael", null)).toBe(
      "Hi Michael,\n\nGreat to hear from you, and appreciate the willingness to talk. My scheduling tool will send over some times along with a Teams invite once you confirm.\n\nBest,\nSebastian",
    );
  });
  it("slots one detail sentence in the middle", async () => {
    const { positiveDraft } = await import("../lib/inbox-draft");
    const d = positiveDraft("Ravi", "Dallas on October 22 works on my end.");
    expect(d).toContain("willingness to talk. Dallas on October 22 works on my end. My scheduling tool");
  });
});
