import { describe, expect, it } from "vitest";
import { applyHandled, forWeek } from "@/lib/call-logger-handled";

const now = new Date("2026-11-20T15:00:00Z");

describe("Call Logger memory", () => {
  it("remembers dismissed and logged meetings per week, and can bring one back", () => {
    let m = applyHandled({}, { set: { ids: ["a", "b"], status: "dismissed", week: "2026-11-16" } }, now);
    m = applyHandled(m, { set: { ids: ["c"], status: "logged", week: "2026-11-16" } }, now);
    m = applyHandled(m, { set: { ids: ["z"], status: "dismissed", week: "2026-11-09" } }, now);
    expect(Object.keys(forWeek(m, "2026-11-16")).sort()).toEqual(["a", "b", "c"]);
    m = applyHandled(m, { remove: ["b"] }, now);
    expect(Object.keys(forWeek(m, "2026-11-16")).sort()).toEqual(["a", "c"]);
  });
  it("a logged call stays logged if dismissed afterwards; old entries are dropped", () => {
    let m = applyHandled({}, { set: { ids: ["c"], status: "logged", week: "2026-11-16" } }, now);
    m = applyHandled(m, { set: { ids: ["c"], status: "dismissed", week: "2026-11-16" } }, now);
    expect(m.c.status).toBe("logged");
    const later = new Date(now.getTime() + 121 * 86_400_000);
    expect(applyHandled(m, {}, later)).toEqual({});
  });
});
