import { describe, expect, it } from "vitest";
import { isSelfInflictedFlag, withoutSelfFlags, type E1Send } from "@/lib/e1-sends";

describe("send queue review flags", () => {
  it("drops flags about things the app adds or leaves out on purpose", () => {
    // The two real flags from VEERUM, Nov 3 2026.
    expect(isSelfInflictedFlag({ kind: "other", message: "The email has no greeting or recipient name, so it opens straight into 'I have studied Veerum...'." })).toBe(true);
    expect(isSelfInflictedFlag({ kind: "restaurant", message: "The subject says 'Vintage' (Vintage Chophouse & Tavern, a valid Calgary candidate), but the body only says 'a good restaurant nearby', so the subject reference is unexplained." })).toBe(true);
    expect(isSelfInflictedFlag({ kind: "other", message: "Missing sign-off at the end." })).toBe(true);
    expect(isSelfInflictedFlag({ kind: "other", message: "The subject names Metropolitan Grill and Nov 25, but the body only says 'a good restaurant nearby'." })).toBe(true);
    const template = "I will be near [INSERT TOWN AND WEEK] and would love to discuss at your office or a good restaurant nearby. Please let me know if available.";
    expect(isSelfInflictedFlag({ kind: "spelling", message: "'Please let me know if available' is missing a word, such as 'if you are available'." }, template)).toBe(true);
  });
  it("keeps real problems", () => {
    expect(isSelfInflictedFlag({ kind: "restaurant", message: "Vintage Chophouse is in Calgary but the company is in Edmonton." })).toBe(false);
    expect(isSelfInflictedFlag({ kind: "other", message: "The email has two greetings." })).toBe(false);
    expect(isSelfInflictedFlag({ kind: "town", message: "Burnaby is not near the company's address in Ontario." })).toBe(false);
    expect(isSelfInflictedFlag({ kind: "spelling", message: "The company name is written 'Cce' but it is the acronym 'CCE'." }, "Please let me know if available.")).toBe(false);
  });
  it("a row left with no flags reads as clean", () => {
    const row = { status: "review", review_flags: [{ kind: "other", severity: "yellow", message: "The email has no greeting or recipient name." }] } as unknown as E1Send;
    const out = withoutSelfFlags(row);
    expect(out.review_flags).toEqual([]);
    expect(out.status).toBe("ready");
  });
});
