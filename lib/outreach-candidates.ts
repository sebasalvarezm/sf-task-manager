import { getValidCredentials } from "./token-manager";
import { sfQuery, sfFetch, assertSalesforceId } from "./sf-query";
import { getSupabaseAdmin, type SfCredentials } from "./supabase";
import { canonicalizeCountry, isTierOneCountry } from "./outreach-quality";
import { describeResponseFields, pickResponseTypeValue } from "./inbox-salesforce";
import {
  coerceRuleSettings,
  evaluateRule,
  isSequenceStart,
  SEQUENCE_START_TYPES,
  SEQUENCE_STEP_TYPES,
  toDateKey,
  type OutreachSend,
  type RuleSettings,
  type RuleVerdict,
} from "./outreach-rules";
import { addAccountToWeeklyOutreach, type WeeklyOutreachItem } from "./weekly-outreach";

/**
 * Outreach candidates: the accounts Seb used to pull from the "GOGOGO"
 * Salesforce report and check one by one. The pool is every account that got
 * an E1 in the lookback period from the selected users, filtered the way the
 * report is (Valstone record type, headcount band, countries). Each account
 * then gets the rules-of-engagement verdict from lib/outreach-rules.ts and is
 * stored in `outreach_candidates`, where the review screen reads it and Seb's
 * decisions (pushed, skipped) live.
 */

// ── Settings ─────────────────────────────────────────────────────────────────

export type CandidateSettings = RuleSettings & {
  /** How far back an E1 can be to make an account a candidate. */
  lookbackMonths: number;
  minEmployees: number;
  maxEmployees: number;
  /** Canonical country names (see outreach-quality). */
  countries: string[];
  /** Task owners whose E1s do not create candidates (their sends still count for the rule). */
  excludedUsers: string[];
  /** Account record type name; empty means no filter. */
  recordType: string;
  /** How many eligible cards to keep in front of Seb. */
  batchSize: number;
};

export const DEFAULT_CANDIDATE_SETTINGS: CandidateSettings = {
  windowDays: 60,
  maxSendsInWindow: 2,
  inFlightDays: 35,
  lookbackMonths: 12,
  minEmployees: 25,
  maxEmployees: 110,
  countries: ["Australia", "Belgium", "Canada", "Ireland", "Netherlands", "New Zealand", "United Kingdom", "United States"],
  excludedUsers: ["Bennett Fahey"],
  recordType: "Valstone",
  batchSize: 50,
};

const SETTINGS_KEY = "outreach_candidate_settings";

export function coerceCandidateSettings(raw: unknown): CandidateSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : def;
  const strings = (v: unknown, def: string[]) =>
    Array.isArray(v) ? v.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean) : def;
  const d = DEFAULT_CANDIDATE_SETTINGS;
  const minEmployees = num(o.minEmployees, d.minEmployees, 0, 100_000);
  return {
    ...coerceRuleSettings(o),
    lookbackMonths: num(o.lookbackMonths, d.lookbackMonths, 1, 36),
    minEmployees,
    maxEmployees: Math.max(minEmployees, num(o.maxEmployees, d.maxEmployees, 0, 100_000)),
    countries: strings(o.countries, d.countries).map((c) => canonicalizeCountry(c) ?? c),
    excludedUsers: strings(o.excludedUsers, d.excludedUsers),
    recordType: typeof o.recordType === "string" ? o.recordType.trim() : d.recordType,
    batchSize: num(o.batchSize, d.batchSize, 5, 200),
  };
}

export async function getCandidateSettings(): Promise<CandidateSettings> {
  try {
    const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
    return coerceCandidateSettings(data?.value);
  } catch {
    return { ...DEFAULT_CANDIDATE_SETTINGS };
  }
}

export async function saveCandidateSettings(raw: unknown): Promise<CandidateSettings> {
  const settings = coerceCandidateSettings(raw);
  const { error } = await getSupabaseAdmin()
    .from("app_settings")
    .upsert({ key: SETTINGS_KEY, value: settings, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return settings;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ReviewStatus = "open" | "pushed" | "skipped";
export type ScreenStatus = "pending" | "software" | "not_software" | "wrong_market" | "acquired" | "unclear" | "error";

export type CandidateRow = {
  sf_account_id: string;
  account_name: string;
  website: string | null;
  account_url: string | null;
  employees: number | null;
  country: string | null;
  industry: string | null;
  owner_name: string | null;
  last_e1_at: string | null;
  last_e1_by: string | null;
  sends: OutreachSend[];
  rule_status: RuleVerdict["status"];
  rule_reason: string;
  eligible_on: string | null;
  sends_in_window: number;
  screen_status: ScreenStatus;
  screen_reason: string | null;
  screen_facts: Record<string, unknown> | null;
  screened_at: string | null;
  review_status: ReviewStatus;
  skip_reason: string | null;
  reviewed_at: string | null;
  weekly_outreach_id: string | null;
  pushed_week_start: string | null;
  in_pool: boolean;
  refreshed_at: string;
  created_at: string;
  updated_at: string;
};

export type RefreshSummary = {
  scanned: number;
  inPool: number;
  eligible: number;
  waiting: number;
  blocked: number;
  droppedFromPool: number;
};

// ── Salesforce reads ─────────────────────────────────────────────────────────

function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `'${esc(v)}'`).join(",");
}

type TaskRow = {
  AccountId: string | null;
  Subject_Type__c: string | null;
  ActivityDate: string | null;
  CompletedDateTime: string | null;
  Status: string | null;
  IsClosed?: boolean;
  Owner?: { Name?: string | null } | null;
};

function sendDate(t: TaskRow): string | null {
  return t.ActivityDate ?? (t.CompletedDateTime ? t.CompletedDateTime.slice(0, 10) : null);
}

export type AccountRuleData = { sends: OutreachSend[]; stepDates: string[]; hasOpenRce: boolean };

/**
 * Everything the rule needs for a set of accounts, from any user: completed
 * sequence starts (last 400 days), completed E2-E5 step dates, and whether an
 * RCE task is still open. Chunked because SOQL IN lists have a size limit.
 */
export async function loadAccountRuleData(credentials: SfCredentials, accountIds: string[]): Promise<Map<string, AccountRuleData>> {
  const out = new Map<string, AccountRuleData>();
  for (const id of accountIds) out.set(id, { sends: [], stepDates: [], hasOpenRce: false });
  const types = quoteList([...SEQUENCE_START_TYPES, ...SEQUENCE_STEP_TYPES]);
  for (let i = 0; i < accountIds.length; i += 150) {
    const ids = quoteList(accountIds.slice(i, i + 150));
    const rows = await sfQuery<TaskRow>(
      `SELECT AccountId, Subject_Type__c, ActivityDate, CompletedDateTime, Status, IsClosed, Owner.Name FROM Task ` +
        `WHERE AccountId IN (${ids}) AND (` +
        `(Status = 'Completed' AND Subject_Type__c IN (${types}) AND ActivityDate >= LAST_N_DAYS:400) ` +
        `OR (IsClosed = false AND Subject_Type__c LIKE '%RCE%'))`,
      credentials,
    );
    for (const t of rows) {
      if (!t.AccountId) continue;
      const data = out.get(t.AccountId);
      if (!data) continue;
      if (t.IsClosed === false && /RCE/i.test(t.Subject_Type__c ?? "")) {
        data.hasOpenRce = true;
        continue;
      }
      const date = sendDate(t);
      if (!date) continue;
      if (isSequenceStart(t.Subject_Type__c)) data.sends.push({ date, type: t.Subject_Type__c ?? "E1", by: t.Owner?.Name ?? null });
      else if ((SEQUENCE_STEP_TYPES as readonly string[]).includes(t.Subject_Type__c ?? "")) data.stepDates.push(date);
    }
  }
  return out;
}

type PoolRow = TaskRow & {
  Account?: {
    Name?: string | null;
    Website?: string | null;
    NumberOfEmployees?: number | null;
    BillingCountry?: string | null;
    Industry?: string | null;
    Owner?: { Name?: string | null } | null;
    RecordType?: { Name?: string | null } | null;
    Responded__c?: string | boolean | null;
  } | null;
};

export type PoolAccount = {
  id: string;
  name: string;
  website: string | null;
  employees: number | null;
  country: string | null;
  industry: string | null;
  ownerName: string | null;
  lastE1At: string | null;
  lastE1By: string | null;
  respondedPositive: boolean;
};

/** The GOGOGO report, as a query: E1s in the lookback from non-excluded users, grouped by account. */
export async function fetchCandidatePool(credentials: SfCredentials, settings: CandidateSettings): Promise<PoolAccount[]> {
  let responseTypeField: string | null = null;
  let positiveValue: string | null = null;
  try {
    const fields = await describeResponseFields();
    if (fields.responseType) {
      responseTypeField = fields.responseType.name;
      positiveValue = pickResponseTypeValue(fields.responseType.values, "positive");
    }
  } catch {
    responseTypeField = null;
  }
  const extra = responseTypeField ? `, Account.${responseTypeField}` : "";
  const where = [
    `Subject_Type__c = 'E1'`,
    `Status = 'Completed'`,
    `AccountId != null`,
    `ActivityDate >= LAST_N_MONTHS:${settings.lookbackMonths}`,
    settings.recordType ? `Account.RecordType.Name = '${esc(settings.recordType)}'` : null,
    `Account.NumberOfEmployees >= ${settings.minEmployees}`,
    `Account.NumberOfEmployees <= ${settings.maxEmployees}`,
    settings.excludedUsers.length ? `Owner.Name NOT IN (${quoteList(settings.excludedUsers)})` : null,
  ]
    .filter(Boolean)
    .join(" AND ");
  const rows = await sfQuery<PoolRow & { Account?: Record<string, unknown> }>(
    `SELECT AccountId, ActivityDate, CompletedDateTime, Owner.Name, ` +
      `Account.Name, Account.Website, Account.NumberOfEmployees, Account.BillingCountry, Account.Industry, ` +
      `Account.Owner.Name, Account.Responded__c${extra} FROM Task WHERE ${where} ORDER BY ActivityDate DESC`,
    credentials,
  );
  const byAccount = new Map<string, PoolAccount>();
  for (const r of rows) {
    if (!r.AccountId || !r.Account) continue;
    const acc = r.Account as NonNullable<PoolRow["Account"]> & Record<string, unknown>;
    const country = canonicalizeCountry(acc.BillingCountry ?? null);
    if (settings.countries.length && !isTierOneCountry(country, settings.countries)) continue;
    const date = sendDate(r);
    const existing = byAccount.get(r.AccountId);
    if (existing) {
      if (date && (!existing.lastE1At || date > existing.lastE1At)) {
        existing.lastE1At = date;
        existing.lastE1By = r.Owner?.Name ?? null;
      }
      continue;
    }
    const responded = acc.Responded__c === true || (typeof acc.Responded__c === "string" && /^(yes|y|true)$/i.test(acc.Responded__c));
    const typeValue = responseTypeField ? (acc[responseTypeField] as string | null | undefined) : null;
    byAccount.set(r.AccountId, {
      id: r.AccountId,
      name: acc.Name ?? "Unknown account",
      website: acc.Website ?? null,
      employees: typeof acc.NumberOfEmployees === "number" ? acc.NumberOfEmployees : null,
      country,
      industry: acc.Industry ?? null,
      ownerName: acc.Owner?.Name ?? null,
      lastE1At: date,
      lastE1By: r.Owner?.Name ?? null,
      respondedPositive: responded && !!positiveValue && typeValue === positiveValue,
    });
  }
  return [...byAccount.values()];
}

// ── Refresh ──────────────────────────────────────────────────────────────────

/**
 * Rebuild the pool and re-run the rule for every account in it. Seb's own
 * decisions (pushed, skipped, screen verdicts) are kept; only the facts move.
 * Accounts that left the pool (older E1, headcount changed) are marked out.
 */
export async function refreshCandidates(): Promise<RefreshSummary> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const settings = await getCandidateSettings();
  const pool = await fetchCandidatePool(credentials, settings);
  const ruleData = await loadAccountRuleData(credentials, pool.map((a) => a.id));
  const today = toDateKey(new Date());
  const now = new Date().toISOString();

  const summary: RefreshSummary = { scanned: pool.length, inPool: 0, eligible: 0, waiting: 0, blocked: 0, droppedFromPool: 0 };
  const rows = pool.map((a) => {
    const data = ruleData.get(a.id) ?? { sends: [], stepDates: [], hasOpenRce: false };
    const verdict = evaluateRule({ ...data, respondedPositive: a.respondedPositive }, today, settings);
    summary.inPool++;
    if (verdict.status === "eligible") summary.eligible++;
    else if (verdict.status === "wait") summary.waiting++;
    else summary.blocked++;
    return {
      sf_account_id: a.id,
      account_name: a.name,
      website: a.website,
      account_url: `${credentials.instance_url}/${a.id}`,
      employees: a.employees,
      country: a.country,
      industry: a.industry,
      owner_name: a.ownerName,
      last_e1_at: a.lastE1At,
      last_e1_by: a.lastE1By,
      sends: [...data.sends].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 12),
      rule_status: verdict.status,
      rule_reason: verdict.reason,
      eligible_on: verdict.eligibleOn,
      sends_in_window: verdict.sendsInWindow,
      in_pool: true,
      refreshed_at: now,
      updated_at: now,
    };
  });

  const supabase = getSupabaseAdmin();
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("outreach_candidates").upsert(rows.slice(i, i + 200), { onConflict: "sf_account_id" });
    if (error) throw new Error(error.message);
  }
  const { data: dropped, error: dropError } = await supabase
    .from("outreach_candidates")
    .update({ in_pool: false, updated_at: now })
    .eq("in_pool", true)
    .lt("refreshed_at", now)
    .select("sf_account_id");
  if (dropError) throw new Error(dropError.message);
  summary.droppedFromPool = dropped?.length ?? 0;
  return summary;
}

// ── Reads and decisions ──────────────────────────────────────────────────────

/** Columns the review screen needs; screen_facts and bookkeeping stay server-side to keep the phone payload small. */
const LIST_COLUMNS =
  "sf_account_id, account_name, website, account_url, employees, country, industry, owner_name, last_e1_at, last_e1_by, sends, " +
  "rule_status, rule_reason, eligible_on, sends_in_window, screen_status, screen_reason, screen_facts, review_status, skip_reason, reviewed_at, pushed_week_start, refreshed_at";

/** Every account in the pool. Supabase caps a single select at 1,000 rows, so this pages through. */
export async function listCandidates(): Promise<CandidateRow[]> {
  const supabase = getSupabaseAdmin();
  const out: CandidateRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("outreach_candidates")
      .select(LIST_COLUMNS)
      .eq("in_pool", true)
      .order("last_e1_at", { ascending: true, nullsFirst: true })
      .order("sf_account_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as CandidateRow[];
    for (const r of rows) {
      const f = (r.screen_facts ?? null) as Record<string, unknown> | null;
      const g = (f?.group ?? null) as { matched?: boolean; group?: string | null; mainGroup?: string | null } | null;
      out.push({
        ...r,
        sends: Array.isArray(r.sends) ? r.sends.slice(0, 5) : [],
        screen_facts: f ? { summary: f.summary ?? null, ownership: f.ownership ?? null, investment: f.investment ?? null, softwareType: f.softwareType ?? null, linkedin: typeof f.linkedin === "string" ? f.linkedin : null, linkedinChecked: f.linkedinChecked === true, group: g?.matched ? { group: g.group ?? null, mainGroup: g.mainGroup ?? null } : null } : null,
      });
    }
    if (rows.length < page) break;
  }
  return out;
}

export async function skipCandidate(accountId: string, reason: string | null): Promise<CandidateRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .update({ review_status: "skipped", skip_reason: reason?.trim() || null, reviewed_at: now, updated_at: now })
    .eq("sf_account_id", accountId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as CandidateRow;
}

export async function reopenCandidate(accountId: string): Promise<CandidateRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("outreach_candidates")
    .update({ review_status: "open", skip_reason: null, reviewed_at: null, weekly_outreach_id: null, pushed_week_start: null, updated_at: now })
    .eq("sf_account_id", accountId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as CandidateRow;
}

/** Push to this week's Weekly Outreach as an E1 and record it on the card. */
/** The account becomes Seb's once he decides to work it: owner = the signed-in Salesforce user. Best effort. */
async function takeOwnership(accountId: string): Promise<boolean> {
  const credentials = await getValidCredentials();
  if (!credentials?.salesforce_user_id) return false;
  const response = await sfFetch(
    `/services/data/v62.0/sobjects/Account/${accountId}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OwnerId: credentials.salesforce_user_id }) },
    credentials,
  ).catch(() => null);
  return !!response && (response.ok || response.status === 204);
}

export async function pushCandidate(accountId: string, weekStart?: string): Promise<{ row: CandidateRow; item: WeeklyOutreachItem; ownerChanged: boolean }> {
  assertSalesforceId(accountId, "account id");
  const item = await addAccountToWeeklyOutreach({
    accountId,
    outreachType: "E1",
    weekStart,
    source: "outreach",
    sourceReference: "Outreach review",
  });
  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outreach_candidates")
    .update({ review_status: "pushed", reviewed_at: now, weekly_outreach_id: item.id, pushed_week_start: item.week_start, skip_reason: null, updated_at: now })
    .eq("sf_account_id", accountId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  // The check already classified the company; hand the group to Weekly Outreach
  // so Sourcing does not run the classifier a second time.
  const facts = (data as CandidateRow).screen_facts as { group?: { matched?: boolean; group?: string | null; mainGroup?: string | null } | null } | null;
  if (facts?.group?.matched && facts.group.group) {
    const patch: Record<string, string> = { group_name: facts.group.group };
    if (facts.group.mainGroup) patch.industry = facts.group.mainGroup;
    await supabase.from("weekly_outreach").update(patch).eq("id", item.id);
    item.group_name = facts.group.group;
    if (facts.group.mainGroup) item.industry = facts.group.mainGroup;
  }
  const ownerChanged = await takeOwnership(accountId);
  return { row: data as CandidateRow, item, ownerChanged };
}

// ── Check a pasted list (the old Re-Contact) ─────────────────────────────────

export type CheckRow = {
  input: string;
  status: "matched" | "multiple" | "not_found";
  accountId: string | null;
  accountName: string | null;
  accountUrl: string | null;
  owner: string | null;
  matchCount: number;
  verdict: RuleVerdict | null;
  lastSend: OutreachSend | null;
};

type SfAccountLite = { Id: string; Name: string; Owner?: { Name?: string | null } | null };

async function matchAccountsByNames(credentials: SfCredentials, names: string[]): Promise<Array<{ input: string; status: CheckRow["status"]; account: SfAccountLite | null; matchCount: number }>> {
  const all: SfAccountLite[] = [];
  for (let i = 0; i < names.length; i += 20) {
    const where = names.slice(i, i + 20).map((n) => `Name LIKE '%${esc(n)}%'`).join(" OR ");
    all.push(...(await sfQuery<SfAccountLite>(`SELECT Id, Name, Owner.Name FROM Account WHERE ${where} ORDER BY Name ASC LIMIT 2000`, credentials)));
  }
  const unique = [...new Map(all.map((a) => [a.Id, a])).values()];
  return names.map((input) => {
    const needle = input.trim().toLowerCase();
    const candidates = unique.filter((a) => a.Name.toLowerCase().includes(needle)).slice(0, 5);
    if (candidates.length === 0) return { input, status: "not_found" as const, account: null, matchCount: 0 };
    const exact = candidates.find((a) => a.Name.trim().toLowerCase() === needle);
    if (exact) return { input, status: "matched" as const, account: exact, matchCount: candidates.length };
    if (candidates.length === 1) return { input, status: "matched" as const, account: candidates[0], matchCount: 1 };
    return { input, status: "multiple" as const, account: candidates[0], matchCount: candidates.length };
  });
}

export async function checkAccountNames(names: string[]): Promise<CheckRow[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const settings = await getCandidateSettings();
  const matches = await matchAccountsByNames(credentials, names);
  const ids = [...new Set(matches.map((m) => m.account?.Id).filter((id): id is string => !!id))];
  const ruleData = await loadAccountRuleData(credentials, ids);
  const today = toDateKey(new Date());
  return matches.map((m) => {
    if (!m.account) return { input: m.input, status: m.status, accountId: null, accountName: null, accountUrl: null, owner: null, matchCount: m.matchCount, verdict: null, lastSend: null };
    const data = ruleData.get(m.account.Id) ?? { sends: [], stepDates: [], hasOpenRce: false };
    const verdict = evaluateRule(data, today, settings);
    const lastSend = [...data.sends].sort((x, y) => (x.date < y.date ? 1 : -1))[0] ?? null;
    return {
      input: m.input,
      status: m.status,
      accountId: m.account.Id,
      accountName: m.account.Name,
      accountUrl: `${credentials.instance_url}/${m.account.Id}`,
      owner: m.account.Owner?.Name ?? null,
      matchCount: m.matchCount,
      verdict,
      lastSend,
    };
  });
}
