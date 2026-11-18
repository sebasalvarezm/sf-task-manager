import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory tables behind a small chainable Supabase stand-in.
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let seq = 0;
function table(name: string) {
  db[name] ??= [];
  const filters: Array<(r: Row) => boolean> = [];
  let op: { kind: "select" } | { kind: "delete" } | { kind: "update"; patch: Row } | { kind: "insert"; rows: Row[] } | { kind: "upsert"; row: Row; ignore: boolean } = { kind: "select" };
  const hits = () => db[name].filter((r) => filters.every((f) => f(r)));
  const run = (): Row[] => {
    if (op.kind === "update") { const h = hits(); h.forEach((r) => Object.assign(r, (op as { patch: Row }).patch)); return h; }
    if (op.kind === "delete") { const h = hits(); db[name] = db[name].filter((r) => !h.includes(r)); return h; }
    if (op.kind === "insert") { const rows = op.rows.map((r) => ({ id: `id${++seq}`, ...r })); db[name].push(...rows); return rows; }
    if (op.kind === "upsert") {
      const r = op.row;
      const dup = db[name].find((x) => x.source === r.source && x.ref_id === r.ref_id);
      if (dup && op.ignore) return [];
      db[name] = db[name].filter((x) => x !== dup);
      db[name].push({ ...r });
      return [r];
    }
    return hits();
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return api; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return api; },
    gte: (k: string, v: string) => { filters.push((r) => r[k] != null && String(r[k]) >= v); return api; },
    order: () => api,
    limit: () => api,
    insert: (r: Row | Row[]) => { op = { kind: "insert", rows: Array.isArray(r) ? r : [r] }; return api; },
    upsert: (r: Row, o?: { ignoreDuplicates?: boolean }) => { op = { kind: "upsert", row: r, ignore: !!o?.ignoreDuplicates }; return api; },
    update: (p: Row) => { op = { kind: "update", patch: p }; return api; },
    delete: () => { op = { kind: "delete" }; return api; },
    single: async () => ({ data: run()[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      try { resolve({ data: run(), error: null }); } catch (e) { reject?.(e); }
    },
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/sf-query", async (orig) => ({ ...(await orig<object>()), sfQuery: async () => [] }));
const outreachCalls: string[] = [];
vi.mock("@/lib/outreach", async (orig) => ({ ...(await orig<object>()), listSequences: async () => { outreachCalls.push("listSequences"); return []; }, outreachRequest: async (path: string) => { outreachCalls.push(path); throw new Error("no Outreach calls in a first pass"); } }));
const modelCalls: string[] = [];
vi.mock("@/lib/model-cost", async (orig) => ({ ...(await orig<object>()), trackedCreate: async () => { modelCalls.push("model"); throw new Error("no model calls in a first pass"); } }));

import { applyFirstPass, createSendsForWeek, undoFirstPass, updateSend } from "@/lib/e1-sends";
import { runDraftLearning } from "@/lib/draft-learning";

const WEEK = "2026-11-16";
const draft = "Xochi Dec 2: Valstone\n\nI have studied Acme going back to the launch of Acme LINK, the mobile tool, in March 2019. My name is Sebastian.";

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.weekly_outreach = [{ id: "w1", week_start: WEEK, outreach_type: "E1", status: "draft_ready", draft, sf_account_id: "001A", account_name: "Acme", group_name: "Bulk Liquids", sourcing_job_id: "j1", notes: null }];
  db.app_settings = [];
});

describe("Send queue edits are kept and learned from", () => {
  it("a new row saves the first draft once; Seb's edit reaches Weekly Outreach; the next check does not put the old text back", async () => {
    const [id] = await createSendsForWeek(WEEK);
    expect(db.draft_edits).toHaveLength(1);
    expect(db.draft_edits[0]).toMatchObject({ source: "e1", ref_id: id, original: draft });

    const edited = "I have studied Acme going back to the launch of Acme LINK. My name is Sebastian.";
    await updateSend(id, { body: edited });
    expect(db.weekly_outreach[0].draft).toBe(`Xochi Dec 2: Valstone\n\n${edited}`);

    // "Check this week's E1s" again: the row is not taken as re-sourced.
    await createSendsForWeek(WEEK);
    expect(db.e1_sends[0].body).toBe(edited);
    // The saved first draft still holds the tool's version, so the edit counts.
    expect(db.draft_edits).toHaveLength(1);
    expect(db.draft_edits[0].original).toBe(draft);
  });

  it("a real re-source on Weekly Outreach still refreshes the row and starts learning over from the new draft", async () => {
    const [id] = await createSendsForWeek(WEEK);
    const fresh = "Xochi Dec 2: Valstone\n\nI have studied Acme going back to the days operating as Acme Systems. My name is Sebastian.";
    db.weekly_outreach[0].draft = fresh;
    await createSendsForWeek(WEEK);
    expect(db.e1_sends.find((r) => r.id === id)?.body).toBe(fresh.split("\n\n")[1]);
    expect(db.draft_edits[0].original).toBe(fresh);
  });
});

describe("Claude's first pass (Cowork)", () => {
  const mine = "I have studied Acme going back to the launch of Acme LINK. My name is Sebastian.";

  it("saves Claude's text and note, makes no model or Outreach write, and learning starts from Claude's version", async () => {
    const [id] = await createSendsForWeek(WEEK);
    db.e1_sends[0].status = "review";
    db.e1_sends[0].review_flags = [{ kind: "hook", message: "Hook adds a date the source does not show.", severity: "yellow" }];
    modelCalls.length = 0;
    const item = await applyFirstPass(id, { body: mine, note: "Trimmed the hook to the product name.", clearFlags: ["hook"] });
    expect(modelCalls).toEqual([]);
    expect(outreachCalls.filter((c) => c !== "listSequences")).toEqual([]);
    expect(item.body).toBe(mine);
    expect(item.status_reason).toBe("First pass: Trimmed the hook to the product name.");
    expect(item.review_flags.some((f) => f.kind === "hook")).toBe(false);
    expect(item.status).not.toBe("approved");
    expect(db.weekly_outreach[0].draft).toBe(`Xochi Dec 2: Valstone\n\n${mine}`);
    const fp = db.draft_edits.find((r) => r.source === "first_pass")!;
    expect(fp).toMatchObject({ original: draft, final: `Xochi Dec 2: Valstone\n\n${mine}`, sent_at: null });
    expect(db.draft_edits.find((r) => r.source === "e1")!.original).toBe(`Xochi Dec 2: Valstone\n\n${mine}`);
    // A first pass is never counted as an email Seb sent.
    expect((await runDraftLearning(7)).emails).toBe(0);
  });

  it("a second pass keeps the tool's draft for Undo; Undo puts it back", async () => {
    const [id] = await createSendsForWeek(WEEK);
    db.e1_sends[0].status = "ready";
    await applyFirstPass(id, { body: mine, note: "one" });
    await applyFirstPass(id, { body: `${mine} Again.`, note: "two" });
    expect(db.draft_edits.filter((r) => r.source === "first_pass")).toHaveLength(1);
    const back = await undoFirstPass(id);
    expect(back.body).toBe(draft.split("\n\n")[1]);
    expect(back.status_reason).toBeNull();
    expect(db.draft_edits.some((r) => r.source === "first_pass")).toBe(false);
    expect(db.draft_edits.find((r) => r.source === "e1")!.original).toBe(draft);
  });

  it("refuses rows Seb approved or that went to Outreach, a missing note, and em dashes", async () => {
    const [id] = await createSendsForWeek(WEEK);
    db.e1_sends[0].status = "approved";
    await expect(applyFirstPass(id, { body: mine, note: "x" })).rejects.toThrow(/waiting on Seb/);
    db.e1_sends[0].status = "scheduled";
    await expect(applyFirstPass(id, { body: mine, note: "x" })).rejects.toThrow(/waiting on Seb/);
    db.e1_sends[0].status = "review";
    await expect(applyFirstPass(id, { body: mine, note: " " })).rejects.toThrow(/note/);
    await expect(applyFirstPass(id, { body: "I have studied Acme \u2014 since 2019.", note: "x" })).rejects.toThrow(/em dash/);
    expect(db.e1_sends[0].body).toBe(draft.split("\n\n")[1]);
  });
});
