import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory Supabase and Salesforce, so the weekly flow runs with no network ──
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let sfAccounts: Array<{ Id: string; Name: string; Website: string | null; Group__c?: string | null }> = [];

function table(name: string) {
  db[name] ??= [];
  return db[name];
}

function query(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" | "insert" = "select";
  let payload: Row | Row[] | null = null;
  let countOnly = false;
  let limitN = Infinity;
  const run = () => {
    const rows = table(name);
    if (op === "insert") {
      const list = Array.isArray(payload) ? payload : [payload!];
      for (const r of list) {
        if (name === "discovery_candidates" && rows.some((x) => x.domain === r.domain)) return { data: null, error: { message: "duplicate key value" } };
        rows.push({ id: `id${rows.length + 1}`, created_at: new Date().toISOString(), ...r });
      }
      return { data: null, error: null };
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of hit) Object.assign(r, payload);
      return { data: hit, error: null };
    }
    return countOnly ? { data: null, count: hit.length, error: null } : { data: hit.slice(0, limitN), error: null };
  };
  const b: Record<string, unknown> = {
    select: (_c?: string, o?: { count?: string; head?: boolean }) => { if (o?.head) countOnly = true; return b; },
    insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b; },
    update: (p: Row) => { op = "update"; payload = p; return b; },
    upsert: (p: Row) => { const rows = table(name); const i = rows.findIndex((r) => r.key === p.key); if (i >= 0) rows[i] = p; else rows.push(p); return b; },
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
    neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return b; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
    gte: (k: string, v: string) => { filters.push((r) => String(r[k] ?? "") >= v); return b; },
    order: () => b,
    limit: (n: number) => { limitN = n; return b; },
    single: async () => { const r = run(); const d = Array.isArray(r.data) ? r.data[0] : r.data; return { data: d ?? null, error: r.error }; },
    maybeSingle: async () => { const r = run(); const d = Array.isArray(r.data) ? r.data[0] : r.data; return { data: d ?? null, error: r.error }; },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}

vi.mock("../lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (t: string) => query(t) }) }));
vi.mock("../lib/sf-query", () => ({
  sfQuery: async () => sfAccounts,
  sfFetch: async () => new Response("{}", { status: 500 }),
  sfErrorText: async () => "mock",
  assertSalesforceId: (v: string) => v,
}));

import {
  accountFields,
  allocate,
  buildExcludeList,
  checkStaff,
  coerceDiscoverySettings,
  collectRun,
  dedupeMatches,
  indexAccounts,
  discoveryWeek,
  runBody,
  startWeek,
  weekUsage,
  type Thesis,
} from "../lib/discovery";
import { canExtend, mockFindAllClient, projectedCost } from "../lib/parallel";
import { mockPdlClient, staffLine, summarizeStaff } from "../lib/pdl";

const thesis = (id: string, extra: Partial<Thesis> = {}): Thesis => ({
  id, name: id, group_name: id, main_group: null, sequence_name: null, sf_industry: null, sf_group: null,
  exclude_industries: [], objective: "Find rail software", match_conditions: [{ name: "own_software", description: "Sells its own software" }],
  generator: "core", weekly_share: 1, enabled: true, findall_id: null, run_state: null, matched_total: 0, last_extended_at: null, preview: null, ...extra,
});
const pool = Array.from({ length: 60 }, (_, i) => ({ name: `Co ${i}`, url: `https://co${i}.com`, description: `Company ${i} makes rail software. More text.` }));

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  sfAccounts = [];
});

describe("weeks", () => {
  it("Sunday night Montreal belongs to the week starting the next day", () => {
    expect(discoveryWeek(new Date("2026-11-09T03:00:00Z"))).toBe("2026-11-09"); // Sun Nov 8, 10pm EST
    expect(discoveryWeek(new Date("2026-11-11T15:00:00Z"))).toBe("2026-11-09"); // Wednesday
  });
});

describe("pure pieces", () => {
  it("splits the week's matches by weight and skips disabled theses", () => {
    const m = allocate([thesis("a"), thesis("b"), thesis("c"), thesis("d", { enabled: false })], 20);
    expect([...m.values()].reduce((s, n) => s + n, 0)).toBe(20);
    expect(m.has("d")).toBe(false);
    expect([...m.values()].sort()).toEqual([6, 7, 7]);
  });
  it("prices and extension rules follow Parallel's", () => {
    expect(projectedCost("core", 5, true)).toBeCloseTo(2.75);
    expect(projectedCost("core", 7, false)).toBeCloseTo(1.05);
    expect(canExtend({ status: { status: "completed", is_active: false, termination_reason: "match_limit_met" } })).toBe(true);
    expect(canExtend({ status: { status: "completed", is_active: false, termination_reason: "candidates_exhausted" } })).toBe(false);
  });
  it("builds the request with a preview clamp and at most 10,000 exclusions", () => {
    const body = runBody(thesis("rail"), 3, Array.from({ length: 12000 }, (_, i) => ({ name: `x${i}`, url: `https://x${i}.com` })), "preview");
    expect(body.match_limit).toBe(5);
    expect(body.exclude_list).toHaveLength(10000);
  });
  it("excludes past Discovery finds first, then the thesis's Salesforce group", () => {
    const sf = indexAccounts([
      { Id: "1", Name: "A", Website: "a.com", Group__c: "CDM", Industry: "Manufacturing" },
      { Id: "2", Name: "B", Website: "b.com", Group__c: "Transport & Logistics", Industry: "Other" },
      { Id: "3", Name: "Rail One", Website: "railone.com", Group__c: "CDM", Industry: "Transport Execution - Rail" },
      { Id: "4", Name: "Some Fund", Website: "fund.com", Industry: "Fund" },
    ]);
    const list = buildExcludeList({ discovery: [{ name: "Old", domain: "old.com" }], always: ["portfolio.com"], salesforce: sf, sfGroup: "Transport & Logistics", industries: ["Transport Execution - Rail"] });
    expect(list.map((e) => e.url)).toEqual(["https://old.com", "https://portfolio.com", "https://railone.com", "https://b.com", "https://a.com"]);
  });
  it("drops known domains and marks Salesforce hits, sub-domains included", () => {
    const sf = indexAccounts([{ Id: "001", Name: "Acme", Website: "acme.com" }, { Id: "002", Name: "Rail-Tech Inc.", Website: "railtech.ca" }]);
    const out = dedupeMatches(
      [
        { candidate_id: "1", name: "Acme", url: "https://app.acme.com", match_status: "matched" },
        { candidate_id: "5", name: "RailTech", url: "https://railtech.com", match_status: "matched" },
        { candidate_id: "2", name: "Seen", url: "https://seen.io", match_status: "matched" },
        { candidate_id: "3", name: "New", url: "https://www.new.io/about", match_status: "matched" },
        { candidate_id: "4", name: "No", url: "https://no.io", match_status: "unmatched" },
      ],
      sf, new Set(["seen.io"]), [],
    );
    // railtech.com is caught by name although Salesforce has railtech.ca
    expect(out.map((o) => [o.domain, !!o.inSalesforce])).toEqual([["app.acme.com", true], ["railtech.com", true], ["new.io", false]]);
  });
  it("flags, never drops, mostly offshore staff, and says unknown without data", () => {
    const s = summarizeStaff({ employee_count: 40, employee_count_by_country: { "united states": 10, india: 28, other_uncategorized: 2 }, location: { locality: "denver", region: "colorado", country: "united states" } });
    expect(s.flag).toMatch(/outside/);
    expect(s.city).toBe("Denver");
    expect(staffLine(summarizeStaff(null))).toBe("Staff: unknown");
    expect(summarizeStaff({ employee_count_by_country: { canada: 20, "united kingdom": 5 } }).flag).toBeNull();
  });
  it("Push sets owner, industry, group and HQ when known", () => {
    expect(accountFields({ name: "Rail Co", website: null, domain: "railco.com", staff: summarizeStaff({ location: { locality: "omaha", country: "united states" } }) }, { sf_industry: "Transport Execution - Rail", sf_group: "Transport & Logistics" }, "005X")).toEqual({
      Name: "Rail Co", Website: "https://railco.com", OwnerId: "005X", Industry: "Transport Execution - Rail", Group__c: "Transport & Logistics", BillingCity: "Omaha", BillingCountry: "United States",
    });
  });
  it("settings cannot lift the hard ceilings", () => {
    const s = coerceDiscoverySettings({ maxMatchesPerWeek: 5000, maxSpendPerWeek: 999, matchesPerWeek: 40 });
    expect(s.maxMatchesPerWeek).toBe(25);
    expect(s.maxSpendPerWeek).toBe(10);
    expect(s.paused).toBe(true);
  });
});

describe("weekly flow on mocks", () => {
  const settings = coerceDiscoverySettings({ paused: false });
  const week = "2026-11-09";

  it("first week: three new runs, but the $10 cap allows only what fits", async () => {
    const client = mockFindAllClient(pool);
    const theses = [thesis("rail"), thesis("safety"), thesis("process")];
    db.discovery_theses = theses.map((t) => ({ ...t }));
    const steps = await startWeek({ client, week, settings, theses });
    // 7 + 7 + 6 matches; each new run is $2 + $0.15 x n: 3.05 + 3.05 + 2.90 = $9.00
    expect(steps.filter((s) => s.action === "create")).toHaveLength(3);
    const reserved = steps.reduce((s, x) => s + (x.action === "skip" ? 0 : projectedCost("core", x.matches, x.action === "create")), 0);
    expect(reserved).toBeLessThanOrEqual(10);
  });

  it("never spends past the weekly cap: a fourth new run is skipped", async () => {
    const client = mockFindAllClient(pool);
    const theses = ["a", "b", "c", "d"].map((id) => thesis(id));
    db.discovery_theses = theses.map((t) => ({ ...t }));
    const steps = await startWeek({ client, week, settings, theses });
    const started = steps.filter((s) => s.action === "create");
    const cost = started.reduce((s, x) => s + projectedCost("core", x.matches, true), 0);
    expect(cost).toBeLessThanOrEqual(10);
    expect(steps.some((s) => s.action === "skip")).toBe(true);
  });

  it("collects, bills only new matches, dedupes against Salesforce, then extends next week", async () => {
    sfAccounts = [{ Id: "001A", Name: "Co 1", Website: "https://co1.com" }];
    const client = mockFindAllClient(pool);
    const t = thesis("rail");
    db.discovery_theses = [{ ...t }];
    await startWeek({ client, week, settings, theses: [t], onlyThesisId: "rail", matchLimit: 5 });
    const saved = db.discovery_theses[0] as unknown as Thesis;
    expect(saved.findall_id).toBeTruthy();
    // co1 was in Salesforce: still excluded at creation, so the mock never returns it.
    const r1 = await collectRun({ client, thesis: saved, week, settings });
    expect(r1.billed).toBe(5);
    expect(r1.stored).toBe(5);
    expect((await weekUsage(week)).spend).toBe(0); // mock calls never count toward real spend
    // Next week: same run, extended, no new $2.
    const again = db.discovery_theses[0] as unknown as Thesis;
    const steps = await startWeek({ client, week: "2026-11-16", settings, theses: [again], onlyThesisId: "rail", matchLimit: 5 });
    expect(steps[0].action).toBe("extend");
    expect(client.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    const r2 = await collectRun({ client, thesis: db.discovery_theses[0] as unknown as Thesis, week: "2026-11-16", settings });
    expect(r2.billed).toBe(5);
    expect(db.discovery_candidates).toHaveLength(10);
  });

  it("checks staff only for new candidates and stops at the PDL credit cap", async () => {
    db.discovery_candidates = [
      { id: "c1", domain: "a.com", website: "https://a.com", found_week: week, status: "new", staff: null },
      { id: "c2", domain: "b.com", website: "https://b.com", found_week: week, status: "new", staff: null },
      { id: "c3", domain: "c.com", website: "https://c.com", found_week: week, status: "skipped", staff: null },
    ];
    const pdl = mockPdlClient({ "a.com": { employee_count: 30, employee_count_by_country: { canada: 30 } } });
    const r = await checkStaff({ client: pdl, week, settings: { ...settings, pdlCreditsPerMonth: 1 } });
    // a.com used the only credit; b.com waits for next month, c.com was skipped by Seb.
    expect(pdl.calls).toEqual(["a.com"]);
    expect(r).toEqual({ checked: 1, skipped: 1 });
    expect((db.discovery_candidates[1].staff ?? null)).toBeNull();
    // A miss costs nothing: with room, b.com is checked and shows "unknown".
    const r2 = await checkStaff({ client: pdl, week, settings: { ...settings, pdlCreditsPerMonth: 5 } });
    expect(r2.checked).toBe(1);
    expect((db.discovery_candidates[1].staff as { found: boolean }).found).toBe(false);
  });
});
