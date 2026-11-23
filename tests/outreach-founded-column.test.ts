import { describe, expect, it, vi } from "vitest";

// Before supabase/2026-11-outreach-founded.sql is run, the founded column does not exist.
let hasColumn = false;
const selects: string[] = [];
const row = { sf_account_id: "001A", account_name: "Acme", employees: 30, country: "Canada", sends: [{ date: "2026-01-01", type: "E1", by: null }, { date: "2025-06-01", type: "E1", by: null }], screen_facts: null, founded: 2014 };
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      let cols = "";
      const api: Record<string, unknown> = {
        select: (c: string) => { cols = c; selects.push(c); return api; },
        eq: () => api,
        order: () => api,
        range: async () => {
          if (/founded/.test(cols) && !hasColumn) return { data: null, error: { message: "column outreach_candidates.founded does not exist" } };
          const { founded, ...rest } = row;
          return { data: [/founded/.test(cols) ? { ...rest, founded } : rest], error: null };
        },
      };
      return api;
    },
  }),
}));
vi.mock("@/lib/token-manager", () => ({ getValidCredentials: async () => null }));
vi.mock("@/lib/sf-query", () => ({ sfQuery: async () => [], sfFetch: async () => ({}), assertSalesforceId: () => undefined }));

import { isMissingFounded, listCandidates } from "@/lib/outreach-candidates";

describe("founded column", () => {
  it("reads founded and the sequence count once the column exists", async () => {
    hasColumn = true;
    const [r] = await listCandidates();
    expect(r).toMatchObject({ founded: 2014, send_count: 2 });
  });
  it("falls back to the old columns (founded null) when the SQL has not been run", async () => {
    hasColumn = false;
    selects.length = 0;
    const [r] = await listCandidates();
    expect(r).toMatchObject({ founded: null, send_count: 2, account_name: "Acme" });
    expect(selects).toHaveLength(2);
    expect(selects[1]).not.toMatch(/founded/);
  });
  it("recognises the missing-column error and nothing else", () => {
    expect(isMissingFounded("column outreach_candidates.founded does not exist")).toBe(true);
    expect(isMissingFounded("Could not find the 'founded' column of 'outreach_candidates' in the schema cache")).toBe(true);
    expect(isMissingFounded("duplicate key value")).toBe(false);
  });
});
