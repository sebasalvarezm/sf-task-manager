import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/token-manager", () => ({ getValidCredentials: vi.fn(), forceRefreshCredentials: vi.fn() }));
vi.mock("../lib/supabase", () => ({ getSupabaseAdmin: vi.fn() }));

const { callsFromJob, commentaryFromSubject, isShortStyle, mergeCallHistory } = await import("../lib/call-history");

describe("call history", () => {
  it("strips the call-type prefix from the Salesforce subject", () => {
    expect(commentaryFromSubject("C1 - Sub 2M, think will reach it next year")).toBe("Sub 2M, think will reach it next year");
    expect(commentaryFromSubject("RCC – Corum will share data")).toBe("Corum will share data");
    expect(commentaryFromSubject("C1")).toBeNull();
    expect(commentaryFromSubject("")).toBeNull();
  });

  it("keeps only short shorthand lines as style examples", () => {
    expect(isShortStyle("20 FTE, open to discuss, wants F2F in Dallas before sharing data")).toBe(true);
    expect(
      isShortStyle("Profitable, low-churn dock-scheduling platform; AUD $5–6M+ MRR. Likely acquisition conversation within two years."),
    ).toBe(false);
    expect(isShortStyle("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone")).toBe(false);
    expect(isShortStyle("  ")).toBe(false);
  });

  it("reads only the calls a job actually logged, with their follow-up", () => {
    const calls = callsFromJob({
      input: {
        entries: [
          { eventId: "e1", accountId: "001A", accountName: "Voxware", callType: "C1", commentary: "~$4M rev, 20 staff", followUpDays: 6, meetingDate: "2026-09-24" },
          { eventId: "e2", accountId: "001B", accountName: "Dup", callType: "RCC", commentary: "skipped", followUpDays: 5, meetingDate: "2026-09-24" },
          { eventId: "e3", accountId: "001C", accountName: "Failed", callType: "C1", commentary: "failed", followUpDays: null, meetingDate: "2026-09-24" },
        ],
      },
      result: {
        results: [
          { eventId: "e1", success: true },
          { eventId: "e2", success: true, alreadyLogged: true },
          { eventId: "e3", success: false },
        ],
      },
    });
    expect(calls).toEqual([
      expect.objectContaining({ accountName: "Voxware", followUpDays: 6, callType: "C1", source: "app" }),
    ]);
  });

  it("prefers the app's record over the same call from Salesforce", () => {
    const app = [{ source: "app" as const, accountId: "001A", accountName: "A", callType: "C1" as const, commentary: "x", followUpDays: 7, meetingDate: "2026-09-25" }];
    const sf = [
      { source: "salesforce" as const, accountId: "001A", accountName: "A", callType: "C1" as const, commentary: "x", meetingDate: "2026-09-25" },
      { source: "salesforce" as const, accountId: "001B", accountName: "B", callType: "RCC" as const, commentary: "y", meetingDate: "2026-09-20" },
    ];
    expect(mergeCallHistory(app, sf).map((c) => `${c.source}:${c.accountId}`)).toEqual(["app:001A", "salesforce:001B"]);
  });
});
