import { getSupabaseAdmin } from "./supabase";
import { sfQuery } from "./sf-query";
import { buildTrends, FACTOR_LIBRARY, testFactors, validateSpec, type FactorResult, type FactorRow, type FactorSpec, type Trends } from "./outcomes-factors";

/**
 * Storage and running for factor tests (What gets replies, Nov 2026).
 * Every rebuild tests the whole library plus every approved proposal on the
 * latest data, keeps each factor's history, and saves the 4-week trends and a
 * snapshot of the headline numbers. Arithmetic only: no AI anywhere.
 * Proposals (from Claude's weekly Cowork task, or Seb) change nothing until
 * Seb approves them.
 */

const STATE_KEY = "outcomes_factors";
const TITLES_KEY = "outcomes_contact_titles";
const HISTORY_KEY = "outcomes_history";
const HISTORY_CAP = 104;
const RESULT_HISTORY_CAP = 52;
const MAX_PROPOSALS_OPEN = 6;

export type Proposal = {
  spec: FactorSpec;
  status: "proposed" | "approved" | "rejected";
  proposedAt: string;
  decidedAt?: string;
};
export type ResultEntry = {
  latest: FactorResult;
  /** One point per test, oldest first, so a factor's effect can be watched over time. */
  history: Array<{ testedAt: string; verdict: FactorResult["verdict"]; effectPer100: number | null; p: number | null; sends: number }>;
  /** When it was first tested (shown as "new this week"). */
  firstTestedAt: string;
};
export type FactorState = {
  proposals: Proposal[];
  results: Record<string, ResultEntry>;
  trends: Trends | null;
  testedAt: string | null;
};
export type Snapshot = {
  at: string;
  sends: number;
  replyRate: number;
  cleanRepliesPer100: number;
  replyToCall: number;
  you: { last4: Trends["you"]["last4"] } | null;
  team: { last4: Trends["team"]["last4"] } | null;
  act: string[];
};

const empty = (): FactorState => ({ proposals: [], results: {}, trends: null, testedAt: null });

async function readKey<T>(key: string): Promise<{ value: T | null; updatedAt: string | null }> {
  const { data, error } = await getSupabaseAdmin().from("app_settings").select("value, updated_at").eq("key", key).maybeSingle();
  if (error) throw new Error(error.message);
  return { value: (data?.value as T | undefined) ?? null, updatedAt: (data?.updated_at as string | undefined) ?? null };
}

/** Read-change-write with a version check, so two writers never undo each other. */
async function updateKey<T>(key: string, change: (current: T | null) => T): Promise<T> {
  const supabase = getSupabaseAdmin();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value, updatedAt } = await readKey<T>(key);
    const next = change(value);
    if (updatedAt === null) {
      const { error } = await supabase.from("app_settings").insert({ key, value: next });
      if (!error) return next;
      continue;
    }
    const { data, error } = await supabase
      .from("app_settings")
      .update({ value: next, updated_at: new Date().toISOString() })
      .eq("key", key)
      .eq("updated_at", updatedAt)
      .select("key");
    if (error) throw new Error(error.message);
    if (data && data.length === 1) return next;
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  throw new Error(`Could not save ${key}: it kept changing.`);
}

export async function loadFactorState(): Promise<FactorState> {
  return { ...empty(), ...((await readKey<FactorState>(STATE_KEY)).value ?? {}) };
}

export async function loadHistory(): Promise<Snapshot[]> {
  return (await readKey<Snapshot[]>(HISTORY_KEY)).value ?? [];
}

// ── Proposals ───────────────────────────────────────────────────────────────

/** Add a proposed factor (from Claude's weekly suggestions or Seb). Checked field by field; nothing runs until approved. */
export async function proposeFactor(raw: unknown, now = new Date()): Promise<FactorState> {
  const checked = validateSpec(raw);
  if ("error" in checked) throw new Error(checked.error);
  const spec = checked.spec;
  if (FACTOR_LIBRARY.some((f) => f.id === spec.id)) throw new Error(`"${spec.id}" is already a built-in factor.`);
  return updateKey<FactorState>(STATE_KEY, (cur) => {
    const s = { ...empty(), ...(cur ?? {}) };
    if (s.proposals.some((p) => p.spec.id === spec.id)) throw new Error(`A factor called "${spec.id}" was already proposed.`);
    if (s.proposals.filter((p) => p.status === "proposed").length >= MAX_PROPOSALS_OPEN) throw new Error(`${MAX_PROPOSALS_OPEN} proposals are already waiting. Approve or reject some first.`);
    return { ...s, proposals: [...s.proposals, { spec, status: "proposed", proposedAt: now.toISOString() }] };
  });
}

/** Seb approves (it is tested now and at every rebuild) or rejects a proposal. */
export async function decideFactor(id: string, decision: "approve" | "reject", now = new Date()): Promise<FactorState> {
  const state = await updateKey<FactorState>(STATE_KEY, (cur) => {
    const s = { ...empty(), ...(cur ?? {}) };
    const p = s.proposals.find((x) => x.spec.id === id);
    if (!p) throw new Error("Proposal not found.");
    if (p.status !== "proposed") throw new Error("This one was already decided.");
    return { ...s, proposals: s.proposals.map((x) => (x.spec.id === id ? { ...x, status: decision === "approve" ? "approved" : "rejected", decidedAt: now.toISOString() } : x)) };
  });
  if (decision === "approve") {
    const spec = state.proposals.find((p) => p.spec.id === id)!.spec;
    return runFactorTests({ only: [spec], useCachedTitles: true, now });
  }
  return state;
}

// ── Running ─────────────────────────────────────────────────────────────────

async function loadRows(): Promise<FactorRow[]> {
  const out: FactorRow[] = [];
  const db = getSupabaseAdmin();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db
      .from("outreach_sends")
      .select("account_id, account_name, contact_email, sent_on, sender, subject_type, country, employees, founded, industry, prior_sends, weekday, hour_et, mailing_id, sequence_name, subject, opened, replied_at, call_on, quality")
      .order("sent_on", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as FactorRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Contact titles from Salesforce by email (read only), saved so a single approved test can reuse them. */
async function contactTitles(rows: FactorRow[], useCache: boolean): Promise<Record<string, string>> {
  if (useCache) {
    const cached = (await readKey<Record<string, string>>(TITLES_KEY)).value;
    if (cached) return cached;
  }
  const emails = Array.from(new Set(rows.map((r) => String(r.contact_email ?? "").toLowerCase()).filter((e) => /^[^'\\\s]+@[^'\\\s]+$/.test(e))));
  const titles: Record<string, string> = {};
  for (let i = 0; i < emails.length; i += 100) {
    const recs = await sfQuery<{ Email: string | null; Title: string | null }>(
      `SELECT Email, Title FROM Contact WHERE Email IN (${emails.slice(i, i + 100).map((e) => `'${e}'`).join(",")})`,
    ).catch(() => []);
    for (const r of recs) if (r.Email && r.Title) titles[r.Email.toLowerCase()] = r.Title;
  }
  await getSupabaseAdmin().from("app_settings").upsert({ key: TITLES_KEY, value: titles, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return titles;
}

/** Merge new results into the saved ones, keeping each factor's history. Pure. */
export function mergeResults(prev: Record<string, ResultEntry>, results: FactorResult[], now: string): Record<string, ResultEntry> {
  const out = { ...prev };
  for (const r of results) {
    const old = out[r.id];
    const point = { testedAt: r.testedAt, verdict: r.verdict, effectPer100: r.effectPer100, p: r.p, sends: r.a.sends + r.b.sends };
    const history = [...(old?.history ?? []).filter((h) => h.testedAt !== r.testedAt), point].slice(-RESULT_HISTORY_CAP);
    out[r.id] = { latest: r, history, firstTestedAt: old?.firstTestedAt ?? now };
  }
  return out;
}

/**
 * Test factors on the latest outreach_sends. Default: the whole library and
 * every approved proposal, plus the 4-week trends and a history snapshot
 * (the weekly rebuild). With `only`: just those, using cached titles.
 */
export async function runFactorTests(opts: { only?: FactorSpec[]; useCachedTitles?: boolean; now?: Date; headline?: { sends: number; replyRate: number; cleanRepliesPer100: number; replyToCall: number } } = {}): Promise<FactorState> {
  const now = opts.now ?? new Date();
  const asOf = new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10); // Montreal date, near enough
  const rows = await loadRows();
  const titles = await contactTitles(rows, !!opts.useCachedTitles);
  for (const r of rows) r.contact_title = titles[String(r.contact_email ?? "").toLowerCase()] ?? null;
  const current = await loadFactorState();
  const specs = opts.only ?? [...FACTOR_LIBRARY, ...current.proposals.filter((p) => p.status === "approved").map((p) => p.spec)];
  const results = testFactors(specs, rows, asOf);
  const trends = opts.only ? null : buildTrends(rows, asOf);
  const state = await updateKey<FactorState>(STATE_KEY, (cur) => {
    const s = { ...empty(), ...(cur ?? {}) };
    return { ...s, results: mergeResults(s.results, results, asOf), ...(trends ? { trends, testedAt: now.toISOString() } : {}) };
  });
  if (!opts.only && trends) {
    const snap: Snapshot = {
      at: now.toISOString(),
      sends: opts.headline?.sends ?? 0,
      replyRate: opts.headline?.replyRate ?? 0,
      cleanRepliesPer100: opts.headline?.cleanRepliesPer100 ?? 0,
      replyToCall: opts.headline?.replyToCall ?? 0,
      you: { last4: trends.you.last4 },
      team: { last4: trends.team.last4 },
      act: results.filter((r) => r.verdict === "act").map((r) => r.id),
    };
    await updateKey<Snapshot[]>(HISTORY_KEY, (cur) => [...(cur ?? []), snap].slice(-HISTORY_CAP));
  }
  return state;
}

// ── Weekly rebuild ──────────────────────────────────────────────────────────

/** A build already queued or running in the last hour, if any. */
export async function runningOutcomesJob(): Promise<{ id: string; status: string; progress: unknown } | null> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await getSupabaseAdmin()
    .from("jobs")
    .select("id, status, progress")
    .eq("kind", "outcomes_build")
    .in("status", ["queued", "running"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data?.[0] as { id: string; status: string; progress: unknown } | undefined) ?? null;
}
