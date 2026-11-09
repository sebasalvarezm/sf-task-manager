import { describe, expect, it } from "vitest";
import { SCHEDULING_SENTENCE, normalizeDraft, positiveDraft, withSchedulingSentence } from "@/lib/inbox-draft";

describe("scheduling line in positive replies", () => {
  it("is Seb's exact sentence", () => {
    expect(SCHEDULING_SENTENCE).toBe("My scheduling tool will send some times alongside a Teams invite once you confirm.");
  });
  it("rewrites the model's 'Once you confirm, ...' version (AAB, Nov 9 2026)", () => {
    const draft = "Hi Lyn,\n\nThank you, I'd be glad to do that. Happy to keep it general and focused on what we do and how we work with owners.\n\nOnce you confirm, my scheduling tool will send over some times along with a Teams invite. Please include Euan.\n\nBest,\nSebastian";
    expect(normalizeDraft(draft)).toBe(
      "Hi Lyn,\n\nThank you, I'd be glad to do that. Happy to keep it general and focused on what we do and how we work with owners.\n\nMy scheduling tool will send some times alongside a Teams invite once you confirm. Please include Euan.\n\nBest,\nSebastian",
    );
  });
  it("keeps the space when the line sits mid-paragraph, and never doubles it", () => {
    const out = withSchedulingSentence("Glad to talk. My scheduling tool will send times shortly. Our scheduling tool sends a Teams invite too.");
    expect(out).toBe(`Glad to talk. ${SCHEDULING_SENTENCE}`);
  });
  it("the fixed positive reply uses it", () => {
    expect(positiveDraft("Lyn", null)).toContain(SCHEDULING_SENTENCE);
  });
  it("leaves replies without a scheduling line alone", () => {
    const s = "Hi Lyn,\n\nUnderstood. I will leave it there.\n\nBest,\nSebastian";
    expect(normalizeDraft(s)).toBe(s);
  });
});
