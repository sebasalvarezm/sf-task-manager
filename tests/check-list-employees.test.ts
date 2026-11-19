import { describe, expect, it, vi } from "vitest";

const queries: string[] = [];
vi.mock("@/lib/token-manager", () => ({ getValidCredentials: async () => ({ instance_url: "https://sf.example", access_token: "x" }) }));
vi.mock("@/lib/sf-query", () => ({
  assertSalesforceId: () => undefined,
  sfFetch: async () => ({}),
  sfQuery: async (q: string) => {
    queries.push(q);
    if (/FROM Account WHERE/.test(q))
      return [
        { Id: "001A", Name: "Tiny Software Inc", NumberOfEmployees: 7, Owner: { Name: "Seb" } },
        { Id: "001B", Name: "Big Systems Ltd", NumberOfEmployees: 120, Owner: { Name: "Seb" } },
        { Id: "001C", Name: "Blank Co", NumberOfEmployees: null, Owner: null },
      ];
    return [];
  },
}));
function chain(): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "gte", "lte", "order", "limit", "range", "not", "is"]) api[k] = () => api;
  api.maybeSingle = async () => ({ data: null, error: null });
  api.single = async () => ({ data: null, error: null });
  api.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: () => chain() }) }));

import { checkAccountNames } from "@/lib/outreach-candidates";

describe("Check a list shows Salesforce employees", () => {
  it("reads NumberOfEmployees and returns it per row; blank and not-found are null", async () => {
    const rows = await checkAccountNames(["Tiny Software", "Big Systems", "Blank Co", "Nowhere Corp"]);
    expect(queries.some((q) => /SELECT Id, Name, NumberOfEmployees, Owner\.Name FROM Account/.test(q))).toBe(true);
    expect(rows.map((r) => [r.input, r.status, r.employees])).toEqual([
      ["Tiny Software", "matched", 7],
      ["Big Systems", "matched", 120],
      ["Blank Co", "matched", null],
      ["Nowhere Corp", "not_found", null],
    ]);
  });
});
