import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { draft_edits: [], app_settings: [] };
let clock = 0;
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const rows = () => db[name].filter((r) => filters.every((f) => f(r)));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return api; },
    gte: (k: string, v: string) => { filters.push((r) => r[k] != null && String(r[k]) >= v); return api; },
    limit: () => api,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (r: Row) => { db[name].push({ ...r, updated_at: `t${++clock}` }); return { error: null }; },
    upsert: async (r: Row) => { db[name] = db[name].filter((x) => !(x.source === r.source && x.ref_id === r.ref_id)); db[name].push(r); return { error: null }; },
    update: (p: Row) => { patch = p; return api; },
    then: (resolve: (v: unknown) => void) => {
      if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch, name === "app_settings" ? { updated_at: `t${++clock}` } : {})); resolve({ data: hit.map((r) => ({ key: r.key })), error: null }); }
      else resolve({ data: rows(), error: null });
    },
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (n: string) => table(n) }) }));
let modelAnswer = "";
vi.mock("@/lib/anthropic", () => ({ getAnthropicClient: () => ({}), MODELS: { drafting: "claude-sonnet-5-5", extraction: "claude-haiku-5-5" } }));
vi.mock("@/lib/model-cost", () => ({ trackedCreate: async () => ({ content: [{ type: "text", text: modelAnswer }] }) }));

import { decideRule, listLearnedRules, recordDraft, recordFinal, runDraftLearning, verifyProposals, wordDiff, saveLearningSettings } from "@/lib/draft-learning";
import { applyLearnedSwaps, fixEmailWords, learnedStyleText, setLearnedRules } from "@/lib/email-words";

beforeEach(() => { db.draft_edits = []; db.app_settings = []; setLearnedRules([], []); });

const pair = (i: number, original: string, final: string) => ({ source: "rce" as const, ref_id: `r${i}`, account_name: `Co ${i}`, original, final });

describe("word diff", () => {
  it("finds the changed words with context", () => {
    const h = wordDiff("I wanted to reach out about Ecto this week.", "I wanted to email about Ecto this week.");
    expect(h).toEqual([{ removed: "reach out", added: "email", context: "I wanted to" }]);
  });
  it("no change, no hunks", () => {
    expect(wordDiff("Same text.", "Same text.")).toEqual([]);
  });
});

describe("a proposal must be backed by the real text", () => {
  const pairs = [
    pair(1, "Hi Ann, I wanted to reach out about timing.", "Hi Ann, I wanted to email about timing."),
    pair(2, "Hi Bo, happy to reach out again in spring.", "Hi Bo, happy to email again in spring."),
    pair(3, "Hi Cy, I'll reach out in May. Let me know if that works.", "Hi Cy, I'll email in May."),
    pair(4, "Hi Di, thank you. Let me know if that works.", "Hi Di, thank you."),
  ];
  const now = "2026-11-15T22:00:00Z";
  it("a swap seen in 3 emails is proposed, counted in code not by the model", () => {
    const out = verifyProposals({ rules: [{ kind: "swap", from: "reach out", to: "email", summary: "You replace reach out with email.", evidence: [] }] }, pairs, [], now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "swap", from: "reach out", to: "email", emails: 3, status: "proposed" });
  });
  it("a swap seen in only 2 emails is dropped, whatever the model claims", () => {
    expect(verifyProposals({ rules: [{ kind: "swap", from: "Let me know if that works.", to: "", evidence: [{ email: 1 }, { email: 2 }, { email: 3 }] }] }, pairs, [], now)).toEqual([]);
  });
  it("not a habit when he kept it as often as he changed it", () => {
    const mixed = [...pairs, pair(5, "I'll reach out soon.", "I'll reach out soon."), pair(6, "reach out", "reach out"), pair(7, "We reach out", "We reach out")];
    expect(verifyProposals({ rules: [{ kind: "swap", from: "reach out", to: "email" }] }, mixed, [], now)).toEqual([]);
  });
  it("a style rule needs 3 emails whose quoted words are really in the draft and gone from what was sent", () => {
    const style = { kind: "style", rule: "Never end by asking if a time works", summary: "You cut the closing question.", evidence: [
      { email: 3, before: "Let me know if that works.", after: "" },
      { email: 4, before: "Let me know if that works.", after: "" },
      { email: 1, before: "made up words", after: "" },
    ] };
    expect(verifyProposals({ rules: [style] }, pairs, [], now)).toEqual([]);
    const five = [...pairs, pair(5, "Hi Ed. Let me know if that works.", "Hi Ed.")];
    expect(verifyProposals({ rules: [{ ...style, evidence: [...style.evidence, { email: 5, before: "Let me know if that works.", after: "" }] }] }, five, [], now)).toHaveLength(1);
  });
  it("a rejected rule is never proposed again", () => {
    const rejected = [{ id: "x", kind: "swap" as const, from: "reach out", to: "email", summary: "", emails: 3, evidence: [], status: "rejected" as const, createdAt: now }];
    expect(verifyProposals({ rules: [{ kind: "swap", from: "Reach out", to: "email" }] }, pairs, rejected, now)).toEqual([]);
  });
});

describe("accepted rules reach the drafts", () => {
  it("a swap is applied in code, keeping a capital letter; a style rule goes in the prompt", () => {
    expect(applyLearnedSwaps("Reach out anytime. I'll reach out.", [{ from: "reach out", to: "email" }])).toBe("Email anytime. I'll email.");
    setLearnedRules([{ from: "reach out", to: "email" }], ["Keep the body to two sentences"]);
    expect(fixEmailWords("I'll reach out in May.")).toBe("I'll email in May.");
    expect(learnedStyleText()).toContain("Keep the body to two sentences");
  });
});

describe("the whole loop, with stand-ins", () => {
  it("capture, weekly review, accept, then every new draft gets the fix", async () => {
    const texts = [
      ["Hi Ann,\n\nI wanted to reach out about timing.", "Hi Ann,\n\nI wanted to email about timing."],
      ["Hi Bo,\n\nHappy to reach out again in spring.", "Hi Bo,\n\nHappy to email again in spring."],
      ["Hi Cy,\n\nI'll reach out in May.", "Hi Cy,\n\nI'll email in May."],
      ["Hi Di,\n\nThank you for the update.", "Hi Di,\n\nThank you for the update."],
    ];
    for (const [i, [orig, fin]] of texts.entries()) {
      await recordDraft("inbox", `m${i}`, orig, `Co ${i}`);
      await recordFinal("inbox", `m${i}`, fin);
    }
    await recordFinal("inbox", "never-drafted", "Hi"); // no draft captured: ignored
    expect(db.draft_edits).toHaveLength(4);

    modelAnswer = JSON.stringify({ rules: [{ kind: "swap", from: "reach out", to: "email", summary: "You replace \"reach out\" with \"email\"." }] });
    const run = await runDraftLearning(7);
    expect(run).toMatchObject({ emails: 4, edited: 3, proposed: 1 });
    const [rule] = await listLearnedRules();
    expect(rule.status).toBe("proposed");
    expect(fixEmailWords("I'll reach out.")).toBe("I'll reach out."); // nothing changes before Seb accepts

    await decideRule(rule.id, "accept");
    expect(fixEmailWords("I'll reach out.")).toBe("I'll email.");
    await decideRule(rule.id, "remove");
    expect(fixEmailWords("I'll reach out.")).toBe("I'll reach out.");
  });
  it("too few edited emails: no model call, nothing proposed; paused: nothing runs", async () => {
    await recordDraft("rce", "a", "Hi", null);
    await recordFinal("rce", "a", "Hello");
    modelAnswer = "should not be read";
    expect((await runDraftLearning(7)).proposed).toBe(0);
    await saveLearningSettings(true);
    expect((await runDraftLearning(7)).paused).toBe(true);
  });
});
