import { describe, expect, it } from "vitest";
import { pickResponseTypeValue, shouldOverwriteResponseType } from "../lib/inbox-salesforce";

const values = ["Positive", "Neutral", "Negative"];

describe("response type is sticky in the right direction", () => {
  it("fills an empty field", () => {
    expect(shouldOverwriteResponseType(null, "Neutral", values)).toBe(true);
  });
  it("never downgrades Positive to Neutral", () => {
    expect(shouldOverwriteResponseType("Positive", "Neutral", values)).toBe(false);
  });
  it("lets Negative replace anything", () => {
    expect(shouldOverwriteResponseType("Positive", "Negative", values)).toBe(true);
    expect(shouldOverwriteResponseType("Neutral", "Negative", values)).toBe(true);
  });
  it("lets Positive replace Neutral", () => {
    expect(shouldOverwriteResponseType("Neutral", "Positive", values)).toBe(true);
  });
  it("does not walk back a Negative on its own", () => {
    expect(shouldOverwriteResponseType("Negative", "Positive", values)).toBe(false);
  });
  it("maps sentiments onto an org's own labels", () => {
    expect(pickResponseTypeValue(["Interested", "Not now", "Do not contact"], "positive")).toBe("Interested");
    expect(pickResponseTypeValue(["Interested", "Not now", "Do not contact"], "neutral")).toBe("Not now");
    expect(pickResponseTypeValue(["Interested", "Not now", "Do not contact"], "negative")).toBe("Do not contact");
  });
});
