import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { app_settings: [], outreach_sends: [] };
let clock = 0;
function table(name: string) {
  db[name] ??= [];
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let range: [number, number] | null = null;
  const rows = () => db[name].filter((r) => filters.every((f) => f(r)));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return api; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return api; },
    gte: () => api,
    order: () => api,
    limit: () => api,
    range: (a: number, b: number) => { range = [a, b]; return api; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (r: Row) => { db[name].push({ ...r, updated_at: `t${++clock}` }); return { error: null }; },
    upsert: async (r: Row) => { db[name] = db[name].filter((x) => x.key !== r.key); db[name].push({ ...r, updated_at: `t${++clock}` }); return { error: null }; },
    update: (p: Row) => { patch = p; return api; },
    then: (resolve: (v: unknown) => void) => {
      if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch, { updated_at: `t${++clock}` })); resolve({ data: hit.map((r) => ({ key: r.key })), error: null }); }
      else { const all = rows(); resolve({ data: range ? all.slice(range[0], range[1] + 1) : all, error: null }); }
    },
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (n: string) => table(n) }) }));
const sfCalls: string[] = [];
vi.mock("@/lib/sf-query", () => ({ sfQuery: async (q: string) => { sfCalls.push(q); return [{ Email: "ceo@acme.com", Title: "CEO" }]; } }));

import { decideFactor, loadFactorState, loadHistory, mergeResults, proposeFactor, runFactorTests } from "@/lib/outcomes-factors-store";
import type { FactorResult } from "@/lib/outcomes-factors";

const spec = { id: "subject-question", label: "Question mark in the subject", question: "Does a question in the subject help?", aLabel: "question", bLabel: "no question", test: [{ field: "subject", op: "matches", value: "\\?" }], why: "Questions invite an answer." };

function sends(n: number) {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 5) + (i % 200) * 86_400_000).toISOString().slice(0, 10);
    out.push({ account_id: `a${i}`, account_name: `Acme ${i}`, contact_email: i % 2 ? "ceo@acme.com" : `bob${i}@acme.com`, sent_on: d, sender: "Bennett Fahey", subject_type: "E1", country: "Canada", employees: 30, founded: 2012, industry: null, prior_sends: 0, weekday: 2, hour_et: 10, mailing_id: `m${i}`, sequence_name: null, subject: i % 3 ? "Lunch: Valstone" : "Lunch next week?", opened: null, replied_at: i % 5 === 0 ? `${d}T12:00:00Z` : null, call_on: null, quality: "clean" });
  }
  return out;
}

beforeEach(() => { db.app_settings = []; db.outreach_sends = sends(600); sfCalls.length = 0; });

describe("proposals", () => {
  it("a valid proposal waits; approving tests it at once on the saved data with cached titles", async () => {
    await proposeFactor(spec);
    let s = await loadFactorState();
    expect(s.proposals.map((p) => [p.spec.id, p.status])).toEqual([["subject-question", "proposed"]]);
    expect(s.results).toEqual({});
    // The weekly rebuild fills the titles cache; approval reuses it (no Salesforce reads).
    await runFactorTests({ now: new Date("2026-11-16T03:00:00Z"), headline: { sends: 600, replyRate: 0.2, cleanRepliesPer100: 20, replyToCall: 0.3 } });
    const callsAfterRebuild = sfCalls.length;
    s = await decideFactor("subject-question", "approve", new Date("2026-11-17T15:00:00Z"));
    expect(sfCalls.length).toBe(callsAfterRebuild);
    expect(s.proposals[0].status).toBe("approved");
    expect(s.results["subject-question"].latest.a.sends).toBeGreaterThan(0);
  });
  it("refuses duplicates, built-in ids, bad specs and deciding twice", async () => {
    await proposeFactor(spec);
    await expect(proposeFactor(spec)).rejects.toThrow(/already proposed/);
    await expect(proposeFactor({ ...spec, id: "friday" })).rejects.toThrow(/built-in/);
    await expect(proposeFactor({ ...spec, id: "x2", test: [{ field: "salary", op: "known" }] })).rejects.toThrow(/unknown field/);
    await decideFactor("subject-question", "reject");
    await expect(decideFactor("subject-question", "approve")).rejects.toThrow(/already decided/);
    expect((await loadFactorState()).results["subject-question"]).toBeUndefined();
  });
});

describe("rebuild", () => {
  it("tests the library and approved proposals, saves trends and a history snapshot", async () => {
    await proposeFactor(spec);
    await decideFactor("subject-question", "approve");
    const s = await runFactorTests({ now: new Date("2026-11-16T03:00:00Z"), headline: { sends: 600, replyRate: 0.2, cleanRepliesPer100: 20, replyToCall: 0.3 } });
    expect(Object.keys(s.results).length).toBeGreaterThan(20);
    expect(s.results["subject-question"]).toBeDefined();
    expect(s.trends?.team.weeks).toHaveLength(12);
    const h = await loadHistory();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ sends: 600, replyRate: 0.2 });
    // Titles were read from Salesforce and cached.
    expect(sfCalls.length).toBeGreaterThan(0);
  });
  it("mergeResults keeps each factor's history and first-tested date", () => {
    const r = (testedAt: string, effect: number) => ({ id: "f", testedAt, verdict: "nothing", effectPer100: effect, p: 0.5, a: { sends: 50 }, b: { sends: 60 } }) as unknown as FactorResult;
    let m = mergeResults({}, [r("2026-11-09", 1)], "2026-11-09");
    m = mergeResults(m, [r("2026-11-16", 2)], "2026-11-16");
    m = mergeResults(m, [r("2026-11-16", 3)], "2026-11-16"); // same day rerun replaces, not duplicates
    expect(m.f.history.map((h) => [h.testedAt, h.effectPer100])).toEqual([["2026-11-09", 1], ["2026-11-16", 3]]);
    expect(m.f.firstTestedAt).toBe("2026-11-09");
  });
});
