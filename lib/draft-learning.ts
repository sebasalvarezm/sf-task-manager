import { getSupabaseAdmin } from "./supabase";
import { getAnthropicClient, MODELS } from "./anthropic";
import { trackedCreate } from "./model-cost";
import { setLearnedRules, type LearnedSwap } from "./email-words";

/**
 * Learning from Seb's edits (Nov 2026).
 *
 * 1. Capture: every email the tool writes is stored with what Seb actually
 *    sent (draft_edits). Best effort: capture never blocks a send.
 * 2. Weekly review (Sunday): the week's edited emails are compared word by
 *    word, and repeated changes become PROPOSED rules, each with the edits
 *    that back it. A proposal needs the same change in at least 3 different
 *    emails, checked in code against the real text, not the model's say-so.
 * 3. Seb accepts or rejects each one on the Weekly check page. Nothing
 *    changes before that. An accepted word swap is applied in code to every
 *    draft (fixEmailWords); an accepted style rule goes into the drafting
 *    prompts. Rejected proposals never come back. Every rule can be removed.
 */

export type DraftSource = "e1" | "rce" | "followup" | "nudge" | "inbox";
export const SOURCE_LABEL: Record<DraftSource, string> = { e1: "E1", rce: "RCE", followup: "Follow-up", nudge: "Nudge", inbox: "Inbox reply" };

/** Same change in at least this many different emails before it is proposed. */
export const MIN_EMAILS = 3;
const MAX_PROPOSALS = 8;
const RULES_KEY = "learned_rules";
const SETTINGS_KEY = "draft_learning_settings";

// ── Capture ─────────────────────────────────────────────────────────────────

/** The tool wrote a draft. Replaces any earlier draft for the same row (Redraft). Never throws. */
export async function recordDraft(source: DraftSource, refId: string | null | undefined, original: string | null | undefined, accountName?: string | null): Promise<void> {
  if (!refId || !original?.trim()) return;
  try {
    await getSupabaseAdmin()
      .from("draft_edits")
      .upsert({ source, ref_id: refId, account_name: accountName ?? null, original: original.trim(), final: null, sent_at: null, drafted_at: new Date().toISOString() }, { onConflict: "source,ref_id" });
  } catch {
    /* table not created yet, or a hiccup: learning just skips this one */
  }
}

/**
 * The email went out. Stores what was sent next to the draft. When no draft
 * was captured and `original` is given (E1: the Sourcing draft), both are
 * stored now. Never throws.
 */
export async function recordFinal(source: DraftSource, refId: string | null | undefined, final: string | null | undefined, opts: { original?: string | null; accountName?: string | null } = {}): Promise<void> {
  if (!refId || !final?.trim()) return;
  try {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const { data } = await supabase.from("draft_edits").select("source").eq("source", source).eq("ref_id", refId).maybeSingle();
    if (data) {
      await supabase.from("draft_edits").update({ final: final.trim(), sent_at: now }).eq("source", source).eq("ref_id", refId);
    } else if (opts.original?.trim()) {
      await supabase.from("draft_edits").insert({ source, ref_id: refId, account_name: opts.accountName ?? null, original: opts.original.trim(), final: final.trim(), sent_at: now });
    }
  } catch {
    /* best effort */
  }
}

// ── Word diff (pure) ────────────────────────────────────────────────────────

export type Hunk = { removed: string; added: string; context: string };

/** Changed stretches between two texts, word by word, with a few words of context. */
export function wordDiff(a: string, b: string, contextWords = 4): Hunk[] {
  const A = a.split(/\s+/).filter(Boolean);
  const B = b.split(/\s+/).filter(Boolean);
  if (A.length * B.length > 600_000) return [{ removed: a.slice(0, 300), added: b.slice(0, 300), context: "" }];
  const n = A.length;
  const m = B.length;
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let rem: string[] = [];
  let add: string[] = [];
  let startI = 0;
  const flush = () => {
    if (rem.length || add.length) hunks.push({ removed: rem.join(" "), added: add.join(" "), context: A.slice(Math.max(0, startI - contextWords), startI).join(" ") });
    rem = [];
    add = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      flush();
      i++;
      j++;
      startI = i;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
      add.push(B[j++]);
    } else {
      rem.push(A[i++]);
    }
  }
  flush();
  return hunks;
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** True when `final` differs from `original` beyond whitespace. */
export function wasEdited(original: string, final: string): boolean {
  return norm(original) !== norm(final);
}

// ── Rules ───────────────────────────────────────────────────────────────────

export type RuleEvidence = { source: DraftSource; account: string | null; before: string; after: string };
export type LearnedRule = {
  id: string;
  kind: "swap" | "style";
  /** swap: replace `from` with `to` ("" = delete). */
  from?: string;
  to?: string;
  /** style: one plain sentence for the prompts. */
  rule?: string;
  /** Plain-English summary for the review card. */
  summary: string;
  emails: number;
  evidence: RuleEvidence[];
  status: "proposed" | "active" | "rejected" | "removed";
  createdAt: string;
  decidedAt?: string;
};

async function readRules(): Promise<{ rules: LearnedRule[]; updatedAt: string | null }> {
  const { data, error } = await getSupabaseAdmin().from("app_settings").select("value, updated_at").eq("key", RULES_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  const rules = (data?.value as { rules?: LearnedRule[] } | undefined)?.rules;
  return { rules: Array.isArray(rules) ? rules : [], updatedAt: (data?.updated_at as string | undefined) ?? null };
}

async function updateRules(change: (rules: LearnedRule[]) => LearnedRule[]): Promise<LearnedRule[]> {
  const supabase = getSupabaseAdmin();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { rules, updatedAt } = await readRules();
    const next = change(rules.map((r) => ({ ...r })));
    if (updatedAt === null) {
      const { error } = await supabase.from("app_settings").insert({ key: RULES_KEY, value: { rules: next } });
      if (!error) return next;
      continue;
    }
    const { data, error } = await supabase
      .from("app_settings")
      .update({ value: { rules: next }, updated_at: new Date().toISOString() })
      .eq("key", RULES_KEY)
      .eq("updated_at", updatedAt)
      .select("key");
    if (error) throw new Error(error.message);
    if (data && data.length === 1) return next;
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  throw new Error("Could not save the learned rules: the list kept changing.");
}

export async function listLearnedRules(): Promise<LearnedRule[]> {
  return (await readRules()).rules;
}

let loadedAt = 0;
/** Load accepted rules into the drafting code (cached 5 minutes). Never throws. */
export async function refreshLearnedRules(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < 5 * 60_000) return;
  try {
    const active = (await readRules()).rules.filter((r) => r.status === "active");
    setLearnedRules(
      active.filter((r) => r.kind === "swap" && r.from).map((r) => ({ from: r.from!, to: r.to ?? "" }) as LearnedSwap),
      active.filter((r) => r.kind === "style" && r.rule).map((r) => r.rule!),
    );
    loadedAt = Date.now();
  } catch {
    /* keep whatever is loaded */
  }
}

export async function decideRule(id: string, decision: "accept" | "reject" | "remove"): Promise<LearnedRule[]> {
  const rules = await updateRules((rules) => {
    const r = rules.find((x) => x.id === id);
    if (!r) throw new Error("Rule not found.");
    if (decision === "remove" && r.status !== "active") throw new Error("Only an active rule can be removed.");
    if (decision !== "remove" && r.status !== "proposed") throw new Error("This rule was already decided.");
    r.status = decision === "accept" ? "active" : decision === "reject" ? "rejected" : "removed";
    r.decidedAt = new Date().toISOString();
    return rules;
  });
  await refreshLearnedRules(true);
  return rules;
}

export async function getLearningSettings(): Promise<{ paused: boolean }> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  return { paused: (data?.value as { paused?: boolean } | undefined)?.paused === true };
}

export async function saveLearningSettings(paused: boolean): Promise<{ paused: boolean }> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("app_settings").select("key").eq("key", SETTINGS_KEY).maybeSingle();
  const value = { paused };
  const { error } = data
    ? await supabase.from("app_settings").update({ value, updated_at: new Date().toISOString() }).eq("key", SETTINGS_KEY)
    : await supabase.from("app_settings").insert({ key: SETTINGS_KEY, value });
  if (error) throw new Error(error.message);
  return value;
}

// ── Weekly review ───────────────────────────────────────────────────────────

type Pair = { source: DraftSource; ref_id: string; account_name: string | null; original: string; final: string };

const LEARN_SYSTEM = `You study how Sebastian (Seb) Alvarez edits emails that his tool drafted for him, to find habits worth turning into rules.

You get pairs: what the tool wrote, then the word-level changes Seb made before sending. Find REPEATED patterns only, the same kind of change in several different emails. Ignore one-off edits: names, dates, numbers, company facts, a detail only true for that recipient, typo fixes the tool did not cause.

Two kinds of rule:
- "swap": Seb consistently replaces an exact word or phrase with another, or deletes it. Give "from" exactly as the tool wrote it (copy the words) and "to" (empty string to delete). Only short phrases, never whole paragraphs.
- "style": a broader habit you can state as one plain instruction for the drafting model ("Keep the body to two sentences", "Never end with a question asking if a time works").

For every rule, give evidence: the edits that show it, each as {"email": <pair number>, "before": <exact words the tool wrote>, "after": <exact words Seb sent instead, or "">}. Copy the words exactly from the pair. At least 3 different emails per rule.

Answer with JSON only: {"rules":[{"kind":"swap"|"style","from":string,"to":string,"rule":string,"summary":string,"evidence":[{"email":number,"before":string,"after":string}]}]}. "summary" is one short plain sentence for Seb, e.g. "You replace \\"reach out\\" with \\"email\\"." Return {"rules":[]} if nothing repeats.`;

function pairsPrompt(pairs: Pair[]): string {
  return pairs
    .map((p, i) => {
      const hunks = wordDiff(p.original, p.final).slice(0, 12);
      const changes = hunks.map((h) => `  - ...${h.context} [${h.removed || "(nothing)"}] -> [${h.added || "(deleted)"}]`).join("\n");
      return `PAIR ${i + 1} (${SOURCE_LABEL[p.source]}${p.account_name ? `, ${p.account_name}` : ""})\nTool wrote:\n${p.original.slice(0, 1800)}\nSeb's changes:\n${changes}`;
    })
    .join("\n\n");
}

/** Keep only rules the real text backs: the change appears in at least MIN_EMAILS different emails. Pure. */
export function verifyProposals(raw: unknown, pairs: Pair[], existing: LearnedRule[], now: string): LearnedRule[] {
  const list = (raw as { rules?: unknown[] } | null)?.rules;
  if (!Array.isArray(list)) return [];
  const has = (hay: string, needle: string) => needle.trim().length > 0 && hay.toLowerCase().includes(needle.trim().toLowerCase());
  const seenKey = new Set(existing.map((r) => (r.kind === "swap" ? `swap:${norm(r.from ?? "")}` : `style:${norm(r.rule ?? "")}`)));
  const out: LearnedRule[] = [];
  for (const item of list) {
    const r = item as { kind?: string; from?: string; to?: string; rule?: string; summary?: string; evidence?: Array<{ email?: number; before?: string; after?: string }> };
    const kind = r.kind === "swap" ? "swap" : r.kind === "style" ? "style" : null;
    if (!kind) continue;
    let backing: Array<{ p: Pair; before: string; after: string }> = [];
    if (kind === "swap") {
      const from = (r.from ?? "").trim();
      const to = (r.to ?? "").trim();
      if (!from || from.length > 80 || norm(from) === norm(to)) continue;
      // Counted in code: the tool wrote it, Seb's version no longer has it (and has the replacement, if any).
      backing = pairs
        .filter((p) => has(p.original, from) && !has(p.final, from) && (!to || has(p.final, to)))
        .map((p) => ({ p, before: from, after: to }));
      // Not a habit if he kept it about as often as he changed it.
      const kept = pairs.filter((p) => has(p.original, from) && has(p.final, from)).length;
      if (kept >= backing.length) continue;
    } else {
      const rule = (r.rule ?? "").trim();
      if (!rule || rule.length > 220) continue;
      for (const e of r.evidence ?? []) {
        const p = typeof e.email === "number" ? pairs[e.email - 1] : undefined;
        const before = (e.before ?? "").trim();
        const after = (e.after ?? "").trim();
        if (!p || !before || !has(p.original, before) || has(p.final, before)) continue;
        if (after && !has(p.final, after)) continue;
        if (!backing.some((b) => b.p === p)) backing.push({ p, before, after });
      }
    }
    const emails = new Set(backing.map((b) => `${b.p.source}:${b.p.ref_id}`)).size;
    if (emails < MIN_EMAILS) continue;
    const key = kind === "swap" ? `swap:${norm(r.from ?? "")}` : `style:${norm(r.rule ?? "")}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push({
      id: `${kind}-${now.slice(0, 10)}-${out.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      ...(kind === "swap" ? { from: (r.from ?? "").trim(), to: (r.to ?? "").trim() } : { rule: (r.rule ?? "").trim() }),
      summary: (r.summary ?? "").trim().slice(0, 200) || (kind === "swap" ? `Replace "${r.from}" with "${r.to}".` : (r.rule ?? "")),
      emails,
      evidence: backing.slice(0, 3).map((b) => ({ source: b.p.source, account: b.p.account_name, before: b.before.slice(0, 200), after: b.after.slice(0, 200) })),
      status: "proposed",
      createdAt: now,
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}

export type LearningRun = { paused?: boolean; emails: number; edited: number; proposed: number; note?: string };

/** Review the last `days` days of sent emails and add proposals. One model call. */
export async function runDraftLearning(days = 7, now = new Date()): Promise<LearningRun> {
  if ((await getLearningSettings()).paused) return { paused: true, emails: 0, edited: 0, proposed: 0 };
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("draft_edits")
    .select("source, ref_id, account_name, original, final")
    .gte("sent_at", since)
    .limit(400);
  if (error) throw new Error(/draft_edits|relation|schema cache/.test(error.message) ? "The learning table is missing. Run supabase/2026-11-reply-search.sql in Supabase once." : error.message);
  const all = ((data ?? []) as Array<Pair & { final: string | null }>).filter((p): p is Pair => typeof p.final === "string");
  const edited = all.filter((p) => wasEdited(p.original, p.final)).slice(0, 60);
  const run: LearningRun = { emails: all.length, edited: edited.length, proposed: 0 };
  if (edited.length < MIN_EMAILS) return { ...run, note: `Only ${edited.length} edited emails this week, nothing to learn yet.` };
  const client = getAnthropicClient();
  if (!client) return { ...run, note: "No AI key." };
  const res = await trackedCreate(client, "draft_learning", {
    model: MODELS.drafting,
    max_tokens: 3000,
    system: LEARN_SYSTEM,
    messages: [{ role: "user", content: pairsPrompt(edited) }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return { ...run, note: "The review came back unreadable; it runs again next week." };
  }
  const existing = await listLearnedRules();
  const proposals = verifyProposals(parsed, edited, existing, now.toISOString());
  if (proposals.length > 0) await updateRules((rules) => [...rules, ...proposals]);
  return { ...run, proposed: proposals.length };
}
