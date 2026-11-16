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
    upsert: async (r: Row, opts?: { ignoreDuplicates?: boolean }) => {
      const dup = db[name].some((x) => x.source === r.source && x.ref_id === r.ref_id);
      if (dup && opts?.ignoreDuplicates) return { error: null };
      db[name] = db[name].filter((x) => !(x.source === r.source && x.ref_id === r.ref_id)); db[name].push(r); return { error: null };
    },
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
const answers: string[] = [];
const calls: string[] = [];
vi.mock("@/lib/anthropic", () => ({ getAnthropicClient: () => ({}), MODELS: { drafting: "claude-sonnet-5-5", extraction: "claude-haiku-5-5" } }));
vi.mock("@/lib/model-cost", () => ({ trackedCreate: async (_c: unknown, _f: string, req: { system: string }) => { calls.push(req.system); return { content: [{ type: "text", text: answers.length ? answers.shift()! : modelAnswer }] }; } }));

import { collectHooks, decideRule, freezeDraft, hookOf, listLearnedRules, pairFromQueueRow, recordDraft, recordFinal, recordHookRejection, runDraftLearning, verifyHookProposals, verifyProposals, wordDiff, saveLearningSettings } from "@/lib/draft-learning";
import { applyLearnedSwaps, fixEmailWords, learnedHookText, learnedStyleText, setLearnedRules } from "@/lib/email-words";

beforeEach(() => { db.draft_edits = []; db.app_settings = []; setLearnedRules([], []); answers.length = 0; calls.length = 0; });

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

// ── Send queue: first drafts and hooks (Nov 2026) ───────────────────────────

const e1 = (hook: string, rest = "My name is Sebastian, and I lead investment efforts at Valstone.") => `Fancett's Nov 4: Valstone\n\n${hook} ${rest}\n\nI will be near Cambridge in the first week of November.`;

describe("first draft is saved once", () => {
  it("later saves never overwrite it, and the sent version is stored next to it", async () => {
    await freezeDraft("e1", "s1", e1("I have studied Acme going back to the launch of Acme LINK, the mobile tool, in March 2019."), "Acme");
    // Re-research rewrote the draft; a second freeze must not move the starting point.
    await freezeDraft("e1", "s1", e1("I have studied Acme going back to the days operating as Acme Systems."), "Acme");
    await recordFinal("e1", "s1", e1("I have studied Acme going back to the launch of Acme LINK."));
    expect(db.draft_edits).toHaveLength(1);
    expect(String(db.draft_edits[0].original)).toContain("the mobile tool, in March 2019");
    expect(String(db.draft_edits[0].final)).toContain("launch of Acme LINK. My name");
  });
  it("recordDraft (a re-sourced or rebuilt draft) does replace it", async () => {
    await freezeDraft("e1", "s1", "old", null);
    await recordDraft("e1", "s1", "new", null);
    expect(db.draft_edits.map((r) => r.original)).toEqual(["new"]);
  });
});

describe("hooks", () => {
  it("hookOf takes the sentence before 'My name is', with or without a greeting", () => {
    expect(hookOf(e1("I have studied Acme going back to the release of ArcMiner."))).toBe("I have studied Acme going back to the release of ArcMiner.");
    expect(hookOf("Subj\n\nHi Mat,\n\nI have followed Herbst going back to the release of Herbst Attendance. We are building...")).toBe("I have followed Herbst going back to the release of Herbst Attendance.");
  });
  it("collectHooks: kept vs replaced, re-researched hooks counted once", () => {
    const pairs = [
      { source: "e1" as const, ref_id: "a", account_name: "A", original: e1("I have studied A going back to X, the tool, in 2019."), final: e1("I have studied A going back to X.") },
      { source: "e1" as const, ref_id: "b", account_name: "B", original: e1("I have studied B going back to Y."), final: e1("I have studied B going back to Y.") },
      { source: "hook" as const, ref_id: "a:1", account_name: "A", original: "I have studied A going back to X, the tool, in 2019.", final: "I have studied A going back to Z." },
      { source: "hook" as const, ref_id: "c:1", account_name: "C", original: "I have studied C going back to the founding.", final: "" },
    ];
    const h = collectHooks(pairs);
    expect(h.kept).toEqual(["I have studied B going back to Y."]);
    expect(h.replaced.map((c) => [c.ref, c.after])).toEqual([["a", "I have studied A going back to X."], ["c:1", ""]]);
  });
  it("a hook rule needs 3 different replaced hooks, cited by valid number", () => {
    const replaced = ["a", "b", "c", "a:2"].map((ref) => ({ before: `hook ${ref}`, after: "", account: ref, ref }));
    const now = "2026-11-22T22:00:00Z";
    const raw = { rules: [
      { rule: "Name the product and stop", summary: "You cut the description after the product name.", evidence: [1, 2, 3] },
      { rule: "Never use a year", summary: "x", evidence: [1, 4, 4, 9] }, // a and a:2 are the same email, 9 does not exist
    ] };
    const out = verifyHookProposals(raw, replaced, [], now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "hook", rule: "Name the product and stop", emails: 3, status: "proposed" });
    // Already proposed or decided: not proposed again.
    expect(verifyHookProposals(raw, replaced, out, now)).toHaveLength(0);
  });
  it("Sunday run: hook review proposes; accepting puts the rule into the hook writer's instructions", async () => {
    const hooks = [
      ["Acme", "I have studied Acme going back to the launch of Acme LINK, the mobile business intelligence tool, in March 2019.", "I have studied Acme going back to the launch of Acme LINK."],
      ["Bolt", "I have studied Bolt going back to the release of BoltPro, its scheduling module for crews.", "I have studied Bolt going back to the release of BoltPro."],
      ["Cora", "I have studied Cora going back to the days of CoraNet, the dial-up portal for dealers.", "I have studied Cora going back to the days of CoraNet."],
      ["Dyn", "I have studied Dyn going back to the release of DynMap.", "I have studied Dyn going back to the release of DynMap."],
    ];
    for (const [i, [acc, before, after]] of hooks.entries()) {
      await freezeDraft("e1", `s${i}`, e1(before), acc);
      await recordFinal("e1", `s${i}`, e1(after));
    }
    await recordHookRejection("s9", "I have studied Eon going back to the founding in 1983.", "I have studied Eon going back to the days operating as Eon Labs.", "Eon");
    answers.push(JSON.stringify({ rules: [] })); // wording review
    answers.push(JSON.stringify({ rules: [{ rule: "Name the product or old name and stop; never add a clause describing it", summary: "You cut the description after the product name.", evidence: [1, 2, 3] }] }));
    const run = await runDraftLearning(7);
    expect(calls).toHaveLength(2);
    expect(run.bySource).toEqual({ e1: { sent: 4, edited: 3 } });
    expect(run.hooks).toEqual({ kept: 1, replaced: 4, proposed: 1 });
    const rule = (await listLearnedRules()).find((r) => r.kind === "hook")!;
    expect(learnedHookText()).toBe("");
    await decideRule(rule.id, "accept");
    expect(learnedHookText()).toContain("- Name the product or old name and stop; never add a clause describing it.");
    expect(learnedStyleText()).toBe(""); // a hook rule never reaches the email-drafting prompts
  });
});

describe("one-off import of queue edits", () => {
  it("pairs the Weekly Outreach draft with what was scheduled, and skips rows with nothing to compare", () => {
    const row = { id: "q1", weekly_outreach_id: "w1", account_name: "Acme", subject: "Xochi Dec 2: Valstone", body: "I have studied Acme.", scheduled_for: "2026-11-10T14:00:00Z", updated_at: "2026-11-10T13:00:00Z" };
    expect(pairFromQueueRow(row, "Xochi Dec 2: Valstone\r\n\r\nI have studied Acme going back to 2019.")).toEqual({ source: "e1", ref_id: "q1", account_name: "Acme", original: "Xochi Dec 2: Valstone\n\nI have studied Acme going back to 2019.", final: "Xochi Dec 2: Valstone\n\nI have studied Acme.", sent_at: "2026-11-10T14:00:00Z" });
    expect(pairFromQueueRow(row, null)).toBeNull();
    expect(pairFromQueueRow({ ...row, body: null }, "x")).toBeNull();
  });
});
