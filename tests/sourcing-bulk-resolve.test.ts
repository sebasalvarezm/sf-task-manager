import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/salesforce-calls", () => ({
  searchAccountsByName: vi.fn(async (name: string) => [
    { accountId: "001000000000001", accountName: name, accountUrl: "", website: "https://smithjones.com" },
  ]),
}));

const { resolveEntries } = await import("../lib/jobs/sourcing-bulk-runner");

describe("resolveEntries oneToOne", () => {
  it("keeps one item per Weekly Outreach row, in order", async () => {
    const entries = ["https://acme.com", "https://acme.com", "Smith, Jones Inc", ""];
    const items = await resolveEntries(entries, { oneToOne: true });
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.input)).toEqual(["https://acme.com", "https://acme.com", "Smith, Jones Inc", ""]);
    expect(items[2].url).toBe("https://smithjones.com");
    expect(items[3].error).toBeTruthy();
  });

  it("still de-duplicates and splits for pasted Sourcing lists", async () => {
    const items = await resolveEntries(["https://acme.com", "https://ACME.com"]);
    expect(items).toHaveLength(1);
  });
});
