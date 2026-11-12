import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { weekly_outreach: [], app_settings: [] };
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => db[name].filter((r) => filters.every((f) => f(r)));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return api; },
    gte: (k: string, v: string) => { filters.push((r) => String(r[k]) >= v); return api; },
    limit: () => api,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (r: Row) => { db[name].push(r); return { error: null }; },
    then: (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null }),
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/token-manager", () => ({ getValidCredentials: async () => ({ salesforce_user_id: "005SEB000000001AAA" }) }));
const accounts: Record<string, { Name: string; OwnerId: string; Owner: { Name: string } }> = {};
const patches: string[] = [];
vi.mock("@/lib/sf-query", () => ({
  isSalesforceId: (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9]{15,18}$/.test(v),
  sfErrorText: async () => "error",
  sfQuery: async (soql: string) => {
    const me = soql.match(/OwnerId != '(\w+)'/)![1];
    return Object.entries(accounts).filter(([id, a]) => soql.includes(`'${id}'`) && a.OwnerId !== me).map(([Id, a]) => ({ Id, ...a }));
  },
  sfFetch: async (path: string, init: { body: string }) => {
    const id = path.split("/").pop()!;
    accounts[id].OwnerId = JSON.parse(init.body).OwnerId;
    patches.push(id);
    return new Response(null, { status: 204 });
  },
}));

import { claimWeeklyOutreachAccounts, saveOwnerSettings } from "@/lib/account-owner";

const ACC = (n: number) => `001AGRI00000000${n}AA`;
beforeEach(() => {
  db.weekly_outreach = []; db.app_settings = []; patches.length = 0;
  for (const k of Object.keys(accounts)) delete accounts[k];
});

describe("Weekly Outreach accounts become Seb's", () => {
  it("claims this week's and later rows (E1 and RCE), leaves past weeks and accounts already his alone", async () => {
    db.weekly_outreach.push(
      { sf_account_id: ACC(1), week_start: "2026-11-09", outreach_type: "E1" },
      { sf_account_id: ACC(2), week_start: "2026-11-16", outreach_type: "RCE" },
      { sf_account_id: ACC(3), week_start: "2026-11-02", outreach_type: "E1" },
      { sf_account_id: ACC(4), week_start: "2026-11-09", outreach_type: "E1" },
    );
    accounts[ACC(1)] = { Name: "AgriNous", OwnerId: "005TONY000000001AA", Owner: { Name: "Antonio Amormino" } };
    accounts[ACC(2)] = { Name: "Nimbus", OwnerId: "005CARL000000001AA", Owner: { Name: "Carl Khoury" } };
    accounts[ACC(3)] = { Name: "Old week", OwnerId: "005CARL000000001AA", Owner: { Name: "Carl Khoury" } };
    accounts[ACC(4)] = { Name: "Mine already", OwnerId: "005SEB000000001AAA", Owner: { Name: "Sebastian Alvarez" } };
    const run = await claimWeeklyOutreachAccounts(new Date("2026-11-12T15:00:00Z"));
    expect(run.changed.map((c) => c.name).sort()).toEqual(["AgriNous", "Nimbus"]);
    expect(run.changed.find((c) => c.name === "AgriNous")?.from).toBe("Antonio Amormino");
    expect(patches.sort()).toEqual([ACC(1), ACC(2)].sort());
    // Running again changes nothing.
    patches.length = 0;
    expect((await claimWeeklyOutreachAccounts(new Date("2026-11-12T15:00:00Z"))).changed).toEqual([]);
    expect(patches).toEqual([]);
  });
  it("pause stops it", async () => {
    db.weekly_outreach.push({ sf_account_id: ACC(1), week_start: "2026-11-09" });
    accounts[ACC(1)] = { Name: "AgriNous", OwnerId: "005TONY000000001AA", Owner: { Name: "Antonio Amormino" } };
    await saveOwnerSettings(true);
    expect((await claimWeeklyOutreachAccounts(new Date("2026-11-12T15:00:00Z"))).paused).toBe(true);
    expect(patches).toEqual([]);
  });
});
