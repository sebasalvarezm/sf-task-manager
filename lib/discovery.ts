/**
 * Discovery: a weekly search for new industrial VMS companies that are not in
 * Salesforce yet. One standing Parallel FindAll run per sub-group thesis,
 * extended each week so the $2 fixed cost is paid once; exclusions built from
 * Salesforce; every survivor deduped again on website domain; staff split
 * from PDL; Push (Seb's click) creates the Salesforce Account and the Weekly
 * Outreach row.
 *
 * Money rules, all enforced here, server side, before every paid call:
 *   - paused by default; the weekly cron does nothing while paused,
 *   - at most maxMatchesPerWeek billed matches and maxSpendPerWeek dollars
 *     per Discovery week (sum of vendor_calls), counting what a call COULD
 *     cost before it is made,
 *   - PDL capped by credits per calendar month,
 *   - no Claude calls anywhere: the one-liner and citations come from FindAll.
 */
import { getSupabaseAdmin } from "./supabase";
import { sfQuery, sfFetch, sfErrorText } from "./sf-query";
import { getValidCredentials } from "./token-manager";
import { normalizeDomain } from "./account-match";
import { addAccountToWeeklyOutreach, currentWeekStart, type WeeklyOutreachItem } from "./weekly-outreach";
import { FINDALL_PRICES, canExtend, projectedCost, type CreateRunBody, type ExcludeCandidate, type FindAllCandidate, type FindAllClient, type FindAllRun, type Generator, type MatchCondition } from "./parallel";
import { summarizeStaff, type CompanyStaff, type PdlClient } from "./pdl";

// ── Types ────────────────────────────────────────────────────────────────────

export type DiscoverySettings = {
  paused: boolean;
  /** Matches to ask for in a normal week, split across theses by weight. */
  matchesPerWeek: number;
  maxMatchesPerWeek: number;
  maxSpendPerWeek: number;
  pushesPerWeek: number;
  pdlCreditsPerMonth: number;
  /** Extra domains never to surface (portfolio companies not in Salesforce, for example). */
  alwaysExclude: string[];
};

export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  paused: true,
  matchesPerWeek: 20,
  maxMatchesPerWeek: 25,
  maxSpendPerWeek: 10,
  pushesPerWeek: 10,
  pdlCreditsPerMonth: 100,
  alwaysExclude: [],
};

export type Thesis = {
  id: string;
  name: string;
  group_name: string;
  main_group: string | null;
  sequence_name: string | null;
  sf_industry: string | null;
  sf_group: string | null;
  exclude_industries: string[];
  objective: string;
  match_conditions: MatchCondition[];
  generator: Generator;
  weekly_share: number;
  enabled: boolean;
  findall_id: string | null;
  run_state: string | null;
  matched_total: number;
  last_extended_at: string | null;
  preview: { at: string; candidates: Array<{ name: string; url: string; matched: boolean; reason: string | null; inSalesforce?: string | null }> } | null;
};

export type DiscoveryCandidate = {
  id: string;
  thesis_id: string | null;
  findall_id: string | null;
  candidate_id: string | null;
  name: string;
  website: string | null;
  domain: string;
  description: string | null;
  citations: Array<{ url: string; title?: string | null }>;
  reasoning: Record<string, string>;
  found_week: string;
  status: "new" | "in_salesforce" | "pushed" | "skipped";
  in_salesforce_id: string | null;
  staff: CompanyStaff | null;
  sf_account_id: string | null;
  weekly_outreach_id: string | null;
  skip_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
};

const SETTINGS_KEY = "discovery_settings";
const TABLE_HINT = "The Discovery tables are missing. Run supabase/2026-11-discovery.sql in the Supabase SQL editor once.";

function friendly(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/discovery_|vendor_calls/.test(message) && /does not exist|relation|schema cache/.test(message)) return new Error(TABLE_HINT);
  return err instanceof Error ? err : new Error(message);
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function coerceDiscoverySettings(raw: unknown): DiscoverySettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_DISCOVERY_SETTINGS;
  const num = (v: unknown, def: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : def);
  // Hard ceilings no setting can lift: 100 matches and $50 a week.
  const maxMatchesPerWeek = Math.round(num(o.maxMatchesPerWeek, d.maxMatchesPerWeek, 0, 100));
  return {
    paused: typeof o.paused === "boolean" ? o.paused : d.paused,
    maxMatchesPerWeek,
    matchesPerWeek: Math.min(maxMatchesPerWeek, Math.round(num(o.matchesPerWeek, d.matchesPerWeek, 0, 100))),
    maxSpendPerWeek: Math.round(num(o.maxSpendPerWeek, d.maxSpendPerWeek, 0, 50) * 100) / 100,
    pushesPerWeek: Math.round(num(o.pushesPerWeek, d.pushesPerWeek, 0, 100)),
    pdlCreditsPerMonth: Math.round(num(o.pdlCreditsPerMonth, d.pdlCreditsPerMonth, 0, 1000)),
    alwaysExclude: Array.isArray(o.alwaysExclude) ? (o.alwaysExclude as unknown[]).map((s) => normalizeDomain(typeof s === "string" ? s : "")).filter((s): s is string => !!s) : d.alwaysExclude,
  };
}

export async function getDiscoverySettings(): Promise<DiscoverySettings> {
  try {
    const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
    return coerceDiscoverySettings(data?.value);
  } catch {
    return { ...DEFAULT_DISCOVERY_SETTINGS };
  }
}

export async function saveDiscoverySettings(raw: unknown): Promise<DiscoverySettings> {
  const settings = coerceDiscoverySettings(raw);
  const { error } = await getSupabaseAdmin()
    .from("app_settings")
    .upsert({ key: SETTINGS_KEY, value: settings, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw friendly(new Error(error.message));
  return settings;
}

// ── Weeks ────────────────────────────────────────────────────────────────────

/**
 * The Monday a Discovery run is for. The job runs Sunday night Montreal time
 * so candidates are ready Monday; a Sunday belongs to the week that starts
 * the next day. Weekly Outreach weeks start on Monday too.
 */
export function discoveryWeek(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const local = new Date(`${get("year")}-${get("month")}-${get("day")}T12:00:00Z`);
  const dow = local.getUTCDay(); // 0 = Sunday
  const shift = dow === 0 ? 1 : 1 - dow; // Sunday → next Monday; otherwise back to this Monday
  local.setUTCDate(local.getUTCDate() + shift);
  return local.toISOString().slice(0, 10);
}

function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// ── Spend log ────────────────────────────────────────────────────────────────

export async function logVendorCall(row: { vendor: "parallel" | "pdl"; action: string; thesisId?: string | null; weekStart: string; matches?: number; credits?: number; costUsd: number; mock: boolean; detail?: string }): Promise<void> {
  const { error } = await getSupabaseAdmin().from("vendor_calls").insert({
    vendor: row.vendor,
    action: row.action,
    thesis_id: row.thesisId ?? null,
    week_start: row.weekStart,
    matches: row.matches ?? 0,
    credits: row.credits ?? 0,
    cost_usd: Number(row.costUsd.toFixed(4)),
    mock: row.mock,
    detail: row.detail?.slice(0, 500) ?? null,
  });
  // The cap depends on this log, so a failed write stops the run.
  if (error) throw friendly(new Error(`Could not log the ${row.vendor} call: ${error.message}`));
}

export async function weekUsage(weekStart: string): Promise<{ matches: number; spend: number }> {
  const { data, error } = await getSupabaseAdmin().from("vendor_calls").select("matches, cost_usd, vendor").eq("week_start", weekStart).eq("mock", false).limit(5000);
  if (error) throw friendly(new Error(error.message));
  let matches = 0;
  let spend = 0;
  for (const r of (data ?? []) as Array<{ matches: number; cost_usd: number; vendor: string }>) {
    if (r.vendor === "parallel") matches += Number(r.matches ?? 0);
    spend += Number(r.cost_usd ?? 0);
  }
  return { matches, spend };
}

export async function pdlCreditsThisMonth(): Promise<number> {
  const { data, error } = await getSupabaseAdmin().from("vendor_calls").select("credits").eq("vendor", "pdl").eq("mock", false).gte("created_at", monthStartIso()).limit(5000);
  if (error) throw friendly(new Error(error.message));
  return ((data ?? []) as Array<{ credits: number }>).reduce((s, r) => s + Number(r.credits ?? 0), 0);
}

export async function monthSpend(): Promise<{ parallel: number; pdlCredits: number; total: number }> {
  const { data, error } = await getSupabaseAdmin().from("vendor_calls").select("vendor, cost_usd, credits").eq("mock", false).gte("created_at", monthStartIso()).limit(10000);
  if (error) throw friendly(new Error(error.message));
  let parallel = 0;
  let pdlCredits = 0;
  for (const r of (data ?? []) as Array<{ vendor: string; cost_usd: number; credits: number }>) {
    if (r.vendor === "parallel") parallel += Number(r.cost_usd ?? 0);
    else pdlCredits += Number(r.credits ?? 0);
  }
  return { parallel, pdlCredits, total: parallel };
}

// ── Theses ───────────────────────────────────────────────────────────────────

export function coerceThesis(raw: Record<string, unknown>): Partial<Thesis> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const out: Partial<Thesis> = {};
  if (str(raw.name)) out.name = str(raw.name);
  if (str(raw.group_name)) out.group_name = str(raw.group_name);
  if (raw.main_group !== undefined) out.main_group = str(raw.main_group) || null;
  if (raw.sequence_name !== undefined) out.sequence_name = str(raw.sequence_name) || null;
  if (raw.sf_industry !== undefined) out.sf_industry = str(raw.sf_industry) || null;
  if (raw.sf_group !== undefined) out.sf_group = str(raw.sf_group) || null;
  if (str(raw.objective)) out.objective = str(raw.objective);
  if (Array.isArray(raw.match_conditions)) {
    out.match_conditions = (raw.match_conditions as unknown[])
      .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : {}))
      .map((c) => ({ name: String(c.name ?? "").trim().replace(/[^a-z0-9_]/gi, "_").toLowerCase(), description: String(c.description ?? "").trim() }))
      .filter((c) => c.name && c.description)
      .slice(0, 10);
  }
  if (Array.isArray(raw.exclude_industries)) out.exclude_industries = (raw.exclude_industries as unknown[]).map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean).slice(0, 60);
  if (raw.generator === "base" || raw.generator === "core" || raw.generator === "pro") out.generator = raw.generator;
  if (typeof raw.weekly_share === "number" && raw.weekly_share >= 0 && raw.weekly_share <= 10) out.weekly_share = Math.round(raw.weekly_share);
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  return out;
}

export async function listTheses(): Promise<Thesis[]> {
  const { data, error } = await getSupabaseAdmin().from("discovery_theses").select("*").order("created_at", { ascending: true });
  if (error) throw friendly(new Error(error.message));
  return (data ?? []) as Thesis[];
}

export async function getThesis(id: string): Promise<Thesis | null> {
  const { data, error } = await getSupabaseAdmin().from("discovery_theses").select("*").eq("id", id).maybeSingle();
  if (error) throw friendly(new Error(error.message));
  return (data as Thesis | null) ?? null;
}

/**
 * Save edits. A change to what the run searches for (objective, conditions,
 * generator) cannot be applied to a standing FindAll run, so the run is
 * dropped and the next week starts a new one ($2 again).
 */
export async function updateThesis(id: string, raw: Record<string, unknown>): Promise<Thesis> {
  const before = await getThesis(id);
  if (!before) throw new Error("Thesis not found.");
  const patch: Record<string, unknown> = { ...coerceThesis(raw), updated_at: new Date().toISOString() };
  const changesSearch =
    (patch.objective !== undefined && patch.objective !== before.objective) ||
    (patch.generator !== undefined && patch.generator !== before.generator) ||
    (patch.match_conditions !== undefined && JSON.stringify(patch.match_conditions) !== JSON.stringify(before.match_conditions));
  if (changesSearch) {
    patch.findall_id = null;
    patch.run_state = "search changed: a new run starts next time";
    patch.matched_total = 0;
  }
  const { data, error } = await getSupabaseAdmin().from("discovery_theses").update(patch).eq("id", id).select("*").single();
  if (error) throw friendly(new Error(error.message));
  return data as Thesis;
}

/** FindAll request body for a thesis. Pure, so it is tested. */
export function runBody(thesis: Pick<Thesis, "id" | "name" | "objective" | "match_conditions" | "generator">, matchLimit: number, excludeList: ExcludeCandidate[], generator?: Generator): CreateRunBody {
  return {
    objective: thesis.objective,
    entity_type: "companies",
    match_conditions: thesis.match_conditions,
    generator: generator ?? thesis.generator,
    match_limit: generator === "preview" ? Math.min(10, Math.max(5, matchLimit)) : Math.max(5, Math.min(1000, matchLimit)),
    ...(excludeList.length ? { exclude_list: excludeList.slice(0, 10_000) } : {}),
    metadata: { source: "valstone-discovery", thesis: thesis.name },
  };
}

/**
 * How many matches each thesis gets this week: the room left under the cap,
 * split by weight, largest remainders first. Pure, so it is tested.
 */
export function allocate(theses: Array<Pick<Thesis, "id" | "weekly_share" | "enabled">>, total: number): Map<string, number> {
  const live = theses.filter((t) => t.enabled && t.weekly_share > 0);
  const out = new Map<string, number>();
  if (live.length === 0 || total <= 0) return out;
  const weight = live.reduce((s, t) => s + t.weekly_share, 0);
  const raw = live.map((t) => ({ id: t.id, exact: (total * t.weekly_share) / weight }));
  let given = 0;
  for (const r of raw) {
    const n = Math.floor(r.exact);
    out.set(r.id, n);
    given += n;
  }
  for (const r of raw.sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (given >= total) break;
    out.set(r.id, (out.get(r.id) ?? 0) + 1);
    given++;
  }
  return out;
}

// ── Exclusions and dedupe ────────────────────────────────────────────────────

type SfSite = { Id: string; Name: string; Website: string | null; Group__c?: string | null; Industry?: string | null };
export type SfIndex = { byDomain: Map<string, SfSite>; byName: Map<string, SfSite> };

/** Letters and digits only, minus company suffixes: "Rail-Tech Inc." → "railtech". */
export function nameKey(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|sas|bv|nv|plc|pty|oy|ab|as|srl|spa)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Every Salesforce account (about 44,000), by website domain and by name. One paged query. */
export async function salesforceIndex(): Promise<SfIndex> {
  const rows = await sfQuery<SfSite>("SELECT Id, Name, Website, Group__c, Industry FROM Account");
  return indexAccounts(rows);
}

export function indexAccounts(rows: SfSite[]): SfIndex {
  const byDomain = new Map<string, SfSite>();
  const byName = new Map<string, SfSite>();
  for (const r of rows) {
    const d = normalizeDomain(r.Website);
    if (d && !byDomain.has(d)) byDomain.set(d, r);
    const k = nameKey(r.Name);
    if (k.length >= 4 && !byName.has(k)) byName.set(k, r);
  }
  return { byDomain, byName };
}

async function knownDiscoveryDomains(): Promise<Array<{ name: string; domain: string }>> {
  const { data, error } = await getSupabaseAdmin().from("discovery_candidates").select("name, domain").limit(10_000);
  if (error) throw friendly(new Error(error.message));
  return (data ?? []) as Array<{ name: string; domain: string }>;
}

/** Salesforce industries that are never software companies FindAll would return. */
const NEVER_EXCLUDE_INDUSTRIES = new Set(["Fund", "Broker", "Bankers", "Buyside", "Credit Fund", "Distressed Advisor", "Accounting Firm", "Delete"]);

/**
 * The exclude list for a new run. FindAll takes at most 10,000 and Salesforce
 * has about 43,000 accounts with a website, so the order matters:
 *   1. everything Discovery already surfaced, and the always-exclude list,
 *   2. accounts in the thesis's own Salesforce industries, in the order listed,
 *   3. accounts in the thesis's Salesforce group,
 *   4. everything else, except funds, brokers and other non-companies.
 * Whatever does not fit is still caught after the run (domain and name), at
 * $0.15 each, which is why 2 and 3 go first.
 */
export function buildExcludeList(input: { discovery: Array<{ name: string; domain: string }>; always: string[]; salesforce: SfIndex; sfGroup: string | null; industries?: string[] }): ExcludeCandidate[] {
  const out: ExcludeCandidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, domain: string) => {
    if (out.length >= 10_000 || seen.has(domain)) return;
    seen.add(domain);
    out.push({ name: name || domain, url: `https://${domain}` });
  };
  for (const d of input.discovery) add(d.name, d.domain);
  for (const d of input.always) add(d, d);
  const sf = [...input.salesforce.byDomain.entries()];
  for (const ind of input.industries ?? []) for (const [d, a] of sf) if (a.Industry === ind) add(a.Name, d);
  if (input.sfGroup) for (const [d, a] of sf) if (a.Group__c === input.sfGroup) add(a.Name, d);
  for (const [d, a] of sf) if (!NEVER_EXCLUDE_INDUSTRIES.has(a.Industry ?? "")) add(a.Name, d);
  return out;
}

/** Find a candidate in Salesforce: same domain, a sub-domain either way, or the same name. */
export function findInSalesforce(sf: SfIndex, domain: string, name: string): SfSite | null {
  const direct = sf.byDomain.get(domain);
  if (direct) return direct;
  for (const [d, a] of sf.byDomain) if (d.endsWith(`.${domain}`) || domain.endsWith(`.${d}`)) return a;
  const k = nameKey(name);
  return k.length >= 4 ? sf.byName.get(k) ?? null : null;
}

/** Matches worth showing: new domains not in Salesforce. Pure, so it is tested. */
export function dedupeMatches(candidates: FindAllCandidate[], salesforce: SfIndex, known: Set<string>, always: string[]): Array<{ c: FindAllCandidate; domain: string; inSalesforce: SfSite | null }> {
  const out: Array<{ c: FindAllCandidate; domain: string; inSalesforce: SfSite | null }> = [];
  const taken = new Set(known);
  for (const c of candidates) {
    if (c.match_status !== "matched") continue;
    const domain = normalizeDomain(c.url);
    if (!domain || taken.has(domain) || always.includes(domain)) continue;
    taken.add(domain);
    out.push({ c, domain, inSalesforce: findInSalesforce(salesforce, domain, c.name) });
  }
  return out;
}

function oneLine(c: FindAllCandidate): string | null {
  const text = c.description?.trim() || c.basis?.find((b) => b.reasoning)?.reasoning?.trim() || null;
  if (!text) return null;
  const first = text.replace(/\s+/g, " ").replace(/\s*[–—]\s*/g, ", ").split(/(?<=[.!?])\s/)[0];
  return first.slice(0, 220);
}

function citationsOf(c: FindAllCandidate): Array<{ url: string; title: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title: string | null }> = [];
  for (const b of c.basis ?? []) for (const cit of b.citations ?? []) {
    if (!cit.url || seen.has(cit.url)) continue;
    seen.add(cit.url);
    out.push({ url: cit.url, title: cit.title ?? null });
    if (out.length >= 6) return out;
  }
  return out;
}

// ── The weekly run ───────────────────────────────────────────────────────────

export type ThesisStep = { thesisId: string; name: string; action: "create" | "extend" | "skip"; matches: number; reason: string; findallId?: string };

/**
 * Decide and start this week's calls. Each paid call is checked against the
 * caps with its worst-case cost first; anything that would cross a line is
 * skipped with the reason. Returns what was started so the job can wait.
 */
export async function startWeek(opts: { client: FindAllClient; week: string; settings: DiscoverySettings; theses: Thesis[]; onlyThesisId?: string; matchLimit?: number }): Promise<ThesisStep[]> {
  const { client, week, settings } = opts;
  const usage = await weekUsage(week);
  let roomMatches = Math.max(0, settings.maxMatchesPerWeek - usage.matches);
  let roomSpend = Math.max(0, settings.maxSpendPerWeek - usage.spend);
  const theses = opts.onlyThesisId ? opts.theses.filter((t) => t.id === opts.onlyThesisId) : opts.theses.filter((t) => t.enabled);
  const wanted = opts.onlyThesisId ? new Map([[opts.onlyThesisId, opts.matchLimit ?? 5]]) : allocate(theses, Math.min(settings.matchesPerWeek, roomMatches));
  const steps: ThesisStep[] = [];
  let sf: SfIndex | null = null;
  let known: Array<{ name: string; domain: string }> | null = null;

  for (const t of theses) {
    let n = wanted.get(t.id) ?? 0;
    if (n <= 0) continue;
    n = Math.min(n, roomMatches);
    if (n < 1) {
      steps.push({ thesisId: t.id, name: t.name, action: "skip", matches: 0, reason: `match cap of ${settings.maxMatchesPerWeek} reached` });
      continue;
    }
    // Is the standing run still extendable?
    let extend = false;
    if (t.findall_id) {
      const run = await client.getRun(t.findall_id).catch(() => null);
      extend = canExtend(run);
      if (!extend) await setThesisRun(t.id, { run_state: run ? `${run.status.status}: ${run.status.termination_reason ?? "ended"}` : "run not found" });
    }
    // A new run must ask for at least 5 matches (Parallel's minimum).
    if (!extend) n = Math.max(5, n);
    const cost = projectedCost(t.generator, n, !extend);
    if (n > roomMatches || cost > roomSpend + 1e-9) {
      steps.push({ thesisId: t.id, name: t.name, action: "skip", matches: 0, reason: `would cost up to $${cost.toFixed(2)} for ${n} matches; $${roomSpend.toFixed(2)} and ${roomMatches} matches left this week` });
      continue;
    }
    if (extend) {
      const run = await client.extendRun(t.findall_id!, n);
      await setThesisRun(t.id, { run_state: run.status.status, last_extended_at: new Date().toISOString() });
      steps.push({ thesisId: t.id, name: t.name, action: "extend", matches: n, reason: "extended the standing run", findallId: t.findall_id! });
    } else {
      sf ??= await salesforceIndex();
      known ??= await knownDiscoveryDomains();
      const exclude = buildExcludeList({ discovery: known, always: settings.alwaysExclude, salesforce: sf, sfGroup: t.sf_group, industries: t.exclude_industries ?? [] });
      const run = await client.createRun(runBody(t, n, exclude));
      await logVendorCall({ vendor: "parallel", action: "create", thesisId: t.id, weekStart: week, costUsd: FINDALL_PRICES[t.generator].fixed, mock: client.mock, detail: `${t.name}: new ${t.generator} run, ${n} matches, ${exclude.length} excluded` });
      roomSpend -= FINDALL_PRICES[t.generator].fixed;
      await setThesisRun(t.id, { findall_id: run.findall_id, run_state: run.status.status, matched_total: 0, last_extended_at: new Date().toISOString() });
      steps.push({ thesisId: t.id, name: t.name, action: "create", matches: n, reason: `new run, ${exclude.length} companies excluded`, findallId: run.findall_id });
    }
    // Reserve the worst case so the next thesis sees it.
    roomMatches -= n;
    roomSpend -= FINDALL_PRICES[t.generator].perMatch * n;
  }
  return steps;
}

async function setThesisRun(id: string, patch: Partial<Pick<Thesis, "findall_id" | "run_state" | "matched_total" | "last_extended_at">>): Promise<void> {
  const { error } = await getSupabaseAdmin().from("discovery_theses").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw friendly(new Error(error.message));
}

/**
 * After a run finishes: bill the new matches to the log, dedupe, and store
 * the survivors for review. Returns counts for the job summary.
 */
export async function collectRun(opts: { client: FindAllClient; thesis: Thesis; week: string; settings: DiscoverySettings }): Promise<{ matched: number; billed: number; stored: number; inSalesforce: number }> {
  const { client, thesis, week } = opts;
  if (!thesis.findall_id) return { matched: 0, billed: 0, stored: 0, inSalesforce: 0 };
  const result = await client.getResult(thesis.findall_id);
  const matched = result.candidates.filter((c) => c.match_status === "matched");
  const billed = Math.max(0, matched.length - (thesis.matched_total ?? 0));
  if (billed > 0) {
    await logVendorCall({ vendor: "parallel", action: "matches", thesisId: thesis.id, weekStart: week, matches: billed, costUsd: billed * FINDALL_PRICES[thesis.generator].perMatch, mock: client.mock, detail: `${thesis.name}: ${billed} new matches` });
  }
  await setThesisRun(thesis.id, { matched_total: matched.length, run_state: describeRun(result.run) });

  const sf = await salesforceIndex();
  const known = new Set((await knownDiscoveryDomains()).map((k) => k.domain));
  const fresh = dedupeMatches(matched, sf, known, opts.settings.alwaysExclude);
  let stored = 0;
  let inSalesforce = 0;
  for (const { c, domain, inSalesforce: hit } of fresh) {
    const reasoning: Record<string, string> = {};
    for (const b of c.basis ?? []) if (b.reasoning) reasoning[b.field] = b.reasoning.slice(0, 300);
    const { error } = await getSupabaseAdmin().from("discovery_candidates").insert({
      thesis_id: thesis.id,
      findall_id: thesis.findall_id,
      candidate_id: c.candidate_id,
      name: c.name,
      website: c.url,
      domain,
      description: oneLine(c),
      citations: citationsOf(c),
      reasoning,
      found_week: week,
      status: hit ? "in_salesforce" : "new",
      in_salesforce_id: hit?.Id ?? null,
    });
    if (error && !/duplicate key/i.test(error.message)) throw friendly(new Error(error.message));
    if (!error) {
      if (hit) inSalesforce++;
      else stored++;
    }
  }
  return { matched: matched.length, billed, stored, inSalesforce };
}

function describeRun(run: FindAllRun): string {
  const s = run.status;
  return s.is_active ? s.status : `${s.status}${s.termination_reason ? `: ${s.termination_reason}` : ""}`;
}

/** PDL for this week's new candidates that have not been checked, within the monthly credits. */
export async function checkStaff(opts: { client: PdlClient; week: string; settings: DiscoverySettings }): Promise<{ checked: number; skipped: number }> {
  const { data, error } = await getSupabaseAdmin().from("discovery_candidates").select("id, website, domain, staff").eq("found_week", opts.week).eq("status", "new").is("staff", null).limit(100);
  if (error) throw friendly(new Error(error.message));
  const rows = (data ?? []) as Array<{ id: string; website: string | null; domain: string }>;
  let used = await pdlCreditsThisMonth();
  let checked = 0;
  let skipped = 0;
  for (const r of rows) {
    if (used >= opts.settings.pdlCreditsPerMonth) {
      skipped++;
      continue;
    }
    const rec = await opts.client.enrichCompany(r.domain).catch(() => undefined);
    if (rec === undefined) continue; // call failed: leave unchecked, try next time
    const credit = rec ? 1 : 0; // PDL charges matches only
    used += credit;
    await logVendorCall({ vendor: "pdl", action: "enrich", weekStart: opts.week, credits: credit, costUsd: 0, mock: opts.client.mock, detail: r.domain });
    await getSupabaseAdmin().from("discovery_candidates").update({ staff: summarizeStaff(rec), updated_at: new Date().toISOString() }).eq("id", r.id);
    checked++;
  }
  return { checked, skipped };
}

// ── Review ───────────────────────────────────────────────────────────────────

export async function listDiscoveryCandidates(): Promise<DiscoveryCandidate[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("discovery_candidates")
    .select("*")
    .in("status", ["new", "pushed", "skipped"])
    .order("found_week", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) throw friendly(new Error(error.message));
  return (data ?? []) as DiscoveryCandidate[];
}

export async function pushesThisWeek(week = currentWeekStart()): Promise<number> {
  const start = new Date(`${week}T00:00:00`).toISOString();
  const { count, error } = await getSupabaseAdmin().from("discovery_candidates").select("id", { count: "exact", head: true }).eq("status", "pushed").gte("reviewed_at", start);
  if (error) throw friendly(new Error(error.message));
  return count ?? 0;
}

/** Salesforce Account fields for a pushed candidate. Pure, so it is tested. */
export function accountFields(c: Pick<DiscoveryCandidate, "name" | "website" | "domain" | "staff">, thesis: Pick<Thesis, "sf_industry" | "sf_group"> | null, ownerId: string | null): Record<string, string> {
  const f: Record<string, string> = { Name: c.name.trim(), Website: c.website?.trim() || `https://${c.domain}` };
  if (ownerId) f.OwnerId = ownerId;
  if (thesis?.sf_industry) f.Industry = thesis.sf_industry;
  if (thesis?.sf_group) f.Group__c = thesis.sf_group;
  if (c.staff?.city) f.BillingCity = c.staff.city;
  if (c.staff?.region) f.BillingState = c.staff.region;
  if (c.staff?.country) f.BillingCountry = c.staff.country;
  return f;
}

/**
 * Seb's Push: create the Salesforce Account (or reuse one added since the
 * run), add it to this week's Weekly Outreach as an E1 with the thesis's
 * group, so Sourcing skips its classifier. The only Salesforce write here.
 */
export async function pushDiscovery(id: string): Promise<{ candidate: DiscoveryCandidate; weekly: WeeklyOutreachItem; note: string | null }> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("discovery_candidates").select("*").eq("id", id).maybeSingle();
  if (error) throw friendly(new Error(error.message));
  const c = data as DiscoveryCandidate | null;
  if (!c) throw new Error("Candidate not found.");
  if (c.status === "pushed") throw new Error("Already pushed.");
  const settings = await getDiscoverySettings();
  const pushed = await pushesThisWeek();
  if (pushed >= settings.pushesPerWeek) throw new Error(`This week's Discovery quota of ${settings.pushesPerWeek} pushes is used. Raise it on the Discovery page if you want more.`);
  const thesis = c.thesis_id ? await getThesis(c.thesis_id) : null;
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  let note: string | null = null;
  // Added to Salesforce since the run? Use that account, never a duplicate.
  const existing = findInSalesforce(await salesforceIndex(), c.domain, c.name);
  let accountId = existing?.Id ?? null;
  if (accountId) note = `${existing!.Name} was already in Salesforce, so that account was used.`;
  if (!accountId) {
    const fields = accountFields(c, thesis, credentials.salesforce_user_id ?? null);
    let res = await sfFetch("/services/data/v62.0/sobjects/Account", { method: "POST", body: JSON.stringify(fields) }, credentials);
    if (!res.ok) {
      const why = await sfErrorText(res);
      // A picklist value Salesforce will not take: create with the basics and say so.
      const basic = { Name: fields.Name, Website: fields.Website, ...(fields.OwnerId ? { OwnerId: fields.OwnerId } : {}) };
      res = await sfFetch("/services/data/v62.0/sobjects/Account", { method: "POST", body: JSON.stringify(basic) }, credentials);
      if (!res.ok) throw new Error(`Salesforce would not create the account: ${await sfErrorText(res)}`);
      note = `Created with name, website and owner only (${why.slice(0, 120)}). Set industry, group and location in Salesforce.`;
    }
    accountId = ((await res.json()) as { id: string }).id;
  }

  const weekly = await addAccountToWeeklyOutreach({ accountId, outreachType: "E1", source: "discovery", sourceReference: `Discovery: ${thesis?.name ?? "thesis"}` });
  if (thesis?.group_name) {
    const patch: Record<string, string> = { group_name: thesis.group_name };
    if (thesis.main_group) patch.industry = thesis.main_group;
    await sb.from("weekly_outreach").update(patch).eq("id", weekly.id);
    weekly.group_name = thesis.group_name;
    if (thesis.main_group) weekly.industry = thesis.main_group;
  }
  const now = new Date().toISOString();
  const { data: updated, error: upErr } = await sb
    .from("discovery_candidates")
    .update({ status: "pushed", sf_account_id: accountId, weekly_outreach_id: weekly.id, reviewed_at: now, updated_at: now })
    .eq("id", id)
    .select("*")
    .single();
  if (upErr) throw friendly(new Error(upErr.message));
  return { candidate: updated as DiscoveryCandidate, weekly, note };
}

export async function skipDiscovery(id: string, reason: string | null): Promise<DiscoveryCandidate> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("discovery_candidates")
    .update({ status: "skipped", skip_reason: reason?.slice(0, 300) ?? null, reviewed_at: now, updated_at: now })
    .eq("id", id)
    .neq("status", "pushed")
    .select("*")
    .single();
  if (error) throw friendly(new Error(error.message));
  return data as DiscoveryCandidate;
}

export async function reopenDiscovery(id: string): Promise<DiscoveryCandidate> {
  const { data, error } = await getSupabaseAdmin()
    .from("discovery_candidates")
    .update({ status: "new", skip_reason: null, reviewed_at: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "skipped")
    .select("*")
    .single();
  if (error) throw friendly(new Error(error.message));
  return data as DiscoveryCandidate;
}

// ── Preview ──────────────────────────────────────────────────────────────────

/**
 * $0.10 preview of a thesis: about 10 candidates judged, none charged. Sent
 * with the same exclude list a real run would get, and every result checked
 * against Salesforce afterwards, so the preview shows the leak rate (how many
 * would have been companies Seb already has) before any real money is spent.
 */
export async function startPreview(client: FindAllClient, thesis: Thesis): Promise<string> {
  const settings = await getDiscoverySettings();
  const exclude = buildExcludeList({ discovery: await knownDiscoveryDomains(), always: settings.alwaysExclude, salesforce: await salesforceIndex(), sfGroup: thesis.sf_group, industries: thesis.exclude_industries ?? [] });
  const run = await client.createRun(runBody(thesis, 10, exclude, "preview"));
  await logVendorCall({ vendor: "parallel", action: "preview", thesisId: thesis.id, weekStart: discoveryWeek(), costUsd: FINDALL_PRICES.preview.fixed, mock: client.mock, detail: `${thesis.name}: preview, ${exclude.length} excluded` });
  return run.findall_id;
}

export type PreviewItem = { name: string; url: string; matched: boolean; reason: string | null; inSalesforce: string | null };

export async function savePreview(client: FindAllClient, thesis: Thesis, findallId: string): Promise<Thesis["preview"]> {
  const result = await client.getResult(findallId);
  const sf = await salesforceIndex();
  const candidates: PreviewItem[] = result.candidates
    .filter((c) => c.match_status === "matched" || c.match_status === "unmatched")
    .map((c) => {
      const failed = Object.entries(c.output ?? {}).find(([, v]) => v?.is_matched === false)?.[0] ?? null;
      const why = failed ? c.basis?.find((b) => b.field === failed)?.reasoning ?? failed : null;
      const domain = normalizeDomain(c.url);
      const hit = domain ? findInSalesforce(sf, domain, c.name) : null;
      return { name: c.name, url: c.url, matched: c.match_status === "matched", reason: why ? why.slice(0, 200) : null, inSalesforce: hit?.Name ?? null };
    });
  const preview = { at: new Date().toISOString(), candidates };
  const { error } = await getSupabaseAdmin().from("discovery_theses").update({ preview, updated_at: new Date().toISOString() }).eq("id", thesis.id);
  if (error) throw friendly(new Error(error.message));
  return preview;
}
