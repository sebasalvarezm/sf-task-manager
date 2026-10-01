import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({ getSupabaseAdmin: vi.fn() }));
const { changedFields } = await import("../lib/call-corrections");

const base = {
  eventId: "e1",
  suggested: { commentary: "4M rev, open to sale", callType: "C1", followUpDays: 7 },
  final: { commentary: "4M rev, open to sale", callType: "C1", followUpDays: 7 },
};

describe("changedFields", () => {
  it("is empty when you accepted everything as-is", () => {
    expect(changedFields(base)).toEqual([]);
  });
  it("lists each field you changed", () => {
    expect(
      changedFields({ ...base, final: { commentary: "4M rev, founder 60s, open to sale", callType: "RCC", followUpDays: 14 } }),
    ).toEqual(["commentary", "callType", "followUp"]);
  });
  it("counts clearing a suggested follow-up as a change", () => {
    expect(changedFields({ ...base, final: { ...base.final, followUpDays: null } })).toEqual(["followUp"]);
  });
  it("ignores fields that had no suggestion (or that you never touched)", () => {
    expect(
      changedFields({ ...base, suggested: { commentary: null, callType: null, followUpDays: null }, final: { commentary: "x", callType: "C1", followUpDays: 3 } }),
    ).toEqual([]);
  });
});
