import { describe, expect, it } from "vitest";
import { evaluateRule, coerceRuleSettings, addDays, daysBetween } from "../lib/outreach-rules";

const today = "2026-10-17";
const send = (daysAgo: number, type = "E1", by: string | null = "Nate Sabb") => ({ date: addDays(today, -daysAgo), type, by });
// A finished sequence: four steps after the start.
const finished = (startDaysAgo: number) => [startDaysAgo - 3, startDaysAgo - 7, startDaysAgo - 12, startDaysAgo - 20].map((d) => addDays(today, -d));

describe("rolling 60-day rule on sequence starts", () => {
  it("never contacted is eligible", () => {
    const v = evaluateRule({ sends: [] }, today);
    expect(v.status).toBe("eligible");
    expect(v.reason).toBe("Never contacted.");
  });

  it("one send in the window still allows one more", () => {
    const v = evaluateRule({ sends: [send(50)], stepDates: finished(50) }, today);
    expect(v.status).toBe("eligible");
    expect(v.sendsInWindow).toBe(1);
  });

  it("two sends in the last 50 days means wait until the older one is 60 days old", () => {
    const v = evaluateRule({ sends: [send(10), send(50)], stepDates: finished(50) }, today);
    expect(v.status).toBe("wait");
    // The second most recent send was 50 days ago; the window reopens the day after it turns 60.
    expect(v.eligibleOn).toBe(addDays(today, 11));
    expect(daysBetween(today, v.eligibleOn!)).toBe(11);
  });

  it("three sends wait on the second most recent, not the oldest", () => {
    const v = evaluateRule({ sends: [send(5), send(20), send(55)], stepDates: finished(55) }, today);
    expect(v.status).toBe("wait");
    expect(v.eligibleOn).toBe(addDays(today, -20 + 61));
  });

  it("two sends with one outside the window is eligible", () => {
    const v = evaluateRule({ sends: [send(40), send(70)], stepDates: finished(40) }, today);
    expect(v.status).toBe("eligible");
    expect(v.sendsInWindow).toBe(1);
  });

  it("counts sends from any user and any start type", () => {
    const v = evaluateRule({ sends: [send(5, "RCE1", "Sebastian Alvarez"), send(30, "D-E1", "Tyson Hasegawa-Foster")] }, today);
    expect(v.status).toBe("wait");
  });

  it("a fresh E1 with no E5 yet is a running sequence", () => {
    const v = evaluateRule({ sends: [send(12)], stepDates: [addDays(today, -8)] }, today);
    expect(v.status).toBe("wait");
    expect(v.reason).toMatch(/still running/);
    expect(v.eligibleOn).toBe(addDays(today, -12 + 35));
  });

  it("a sequence that reached E5 is not in flight", () => {
    const v = evaluateRule({ sends: [send(12)], stepDates: finished(12).map(() => addDays(today, -2)) }, today);
    expect(v.status).toBe("eligible");
  });

  it("an open RCE task blocks regardless of counts", () => {
    const v = evaluateRule({ sends: [send(200)], hasOpenRce: true }, today);
    expect(v.status).toBe("blocked");
    expect(v.reason).toMatch(/RCE/);
  });

  it("a positive reply blocks and wins over a wait", () => {
    const v = evaluateRule({ sends: [send(5), send(10)], respondedPositive: true }, today);
    expect(v.status).toBe("blocked");
    expect(v.reason).toMatch(/positively/);
  });

  it("ignores future-dated and malformed sends", () => {
    const v = evaluateRule({ sends: [{ date: addDays(today, 30), type: "E1", by: null }, { date: "soon", type: "E1", by: null }] }, today);
    expect(v.status).toBe("eligible");
    expect(v.sendsInWindow).toBe(0);
  });

  it("settings are clamped to sane values", () => {
    expect(coerceRuleSettings({ windowDays: 90, maxSendsInWindow: 1, inFlightDays: 999 })).toEqual({ windowDays: 90, maxSendsInWindow: 1, inFlightDays: 35 });
    expect(coerceRuleSettings(null)).toEqual({ windowDays: 60, maxSendsInWindow: 2, inFlightDays: 35 });
  });
});
