import { describe, expect, it } from "vitest";
import { cleanupItems, cleanupPatch, isNudgeRecord, type CompletedRow } from "@/lib/nudge-cleanup";

const row = (over: Partial<CompletedRow>): CompletedRow => ({
  Id: "00T1",
  Subject: "RCE",
  Type: null,
  Description: "Hi Marcus,\n\nJust checking in.",
  AccountId: "001A",
  LastModifiedDate: "2026-11-02T15:10:00.000+0000",
  ActivityDate: "2026-11-02",
  Account: { Name: "PackageX" },
  ...over,
});

describe("nudge clean-up", () => {
  it("spots nudge records and leaves real RCEs alone", () => {
    expect(isNudgeRecord(row({}))).toBe(true);
    expect(isNudgeRecord(row({ Description: null }))).toBe(false); // RCE code: no email text
    expect(isNudgeRecord(row({ Type: "Email", Subject: "Valstone / PackageX catch up" }))).toBe(false); // Weekly Outreach RCE email
    expect(isNudgeRecord(row({ Subject: "Valstone / FunnelCloud catch up" }))).toBe(false);
  });
  it("re-tags when a next task was opened, reopens when it was the only task", () => {
    const later = [{ Id: "00T2", AccountId: "001A", CreatedDate: "2026-11-02T15:10:03.000+0000" }];
    const [a] = cleanupItems([row({})], later);
    expect(a.hasNextTask).toBe(true);
    expect(cleanupPatch(a)).toEqual({ Subject: "Follow-up email", Subject_Type__c: null });
    const [b] = cleanupItems([row({ AccountId: "001B" })], later);
    expect(b.hasNextTask).toBe(false);
    expect(cleanupPatch(b)).toEqual({ Status: "Open", Description: null });
  });
});
