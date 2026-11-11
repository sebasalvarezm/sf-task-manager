import { describe, expect, it } from "vitest";
import { sixtyDayVerdict } from "@/lib/e1-sends";

const ryan = { id: "a", contact_email: "ryan@integrity.com", contact_name: "Ryan Pivonka", updated_at: "2026-11-25T14:00:00Z" };

describe("60-day rule", () => {
  it("no earlier email: goes", () => {
    expect(sixtyDayVerdict("brian@integrity.com", [], false).blocked).toBeNull();
  });
  it("a different contact is blocked until Seb clears it, and the message names who got the first email", () => {
    const v = sixtyDayVerdict("brian@integrity.com", [ryan], false);
    expect(v.blocked).toMatch(/went to Ryan Pivonka on Nov 25/);
    expect(v.blocked).toMatch(/New contact, send anyway/);
    expect(sixtyDayVerdict("brian@integrity.com", [ryan], true).blocked).toBeNull();
  });
  it("the same person is never emailed twice, cleared or not", () => {
    expect(sixtyDayVerdict("RYAN@integrity.com ", [ryan], true).blocked).toMatch(/same|already got/);
    expect(sixtyDayVerdict("ryan@integrity.com", [ryan], true).sameContact).toBe(true);
  });
});
