import { addDays, startOfWeek, format } from "date-fns";
import { getSupabaseAdmin } from "./supabase";
import { getValidCredentials } from "./token-manager";

export type WeeklyOutreachType = "E1" | "RCE";
export type WeeklyOutreachSource = "tasks" | "recheck" | "manual" | "sourcing";
export type WeeklyOutreachStatus =
  | "queued"
  | "needs_context"
  | "researching"
  | "draft_ready"
  | "approved"
  | "sent";

export type WeeklyOutreachItem = {
  id: string;
  week_start: string;
  outreach_type: WeeklyOutreachType;
  sf_account_id: string;
  account_name: string;
  account_url: string | null;
  website: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
  tier: string | null;
  group_name: string | null;
  source: WeeklyOutreachSource;
  source_reference: string | null;
  rce_days: number | null;
  status: WeeklyOutreachStatus;
  context_summary: string | null;
  draft: string | null;
  notes: string | null;
  sourcing_job_id: string | null;
  created_at: string;
  updated_at: string;
  rce_draft_enabled?: boolean;
  rce_second_sent?: boolean;
  outlook_draft_ready?: boolean;
  outlook_reply_subject?: string | null;
};

export type WeeklyOutreachSourceMetadata = {
  originalReference: string | null;
  outlookDraftId: string | null;
  replyToMessageId: string | null;
  replySubject: string | null;
  rceDraftEnabled: boolean;
  rceSecondSent: boolean;
};

export function readWeeklyOutreachSourceMetadata(
  sourceReference: string | null,
): WeeklyOutreachSourceMetadata {
  if (!sourceReference) {
    return {
      originalReference: null,
      outlookDraftId: null,
      replyToMessageId: null,
      replySubject: null,
      rceDraftEnabled: true,
      rceSecondSent: false,
    };
  }
  try {
    const parsed = JSON.parse(sourceReference) as Partial<WeeklyOutreachSourceMetadata> & {
      weeklyOutreachMetadata?: boolean;
    };
    if (parsed.weeklyOutreachMetadata) {
      return {
        originalReference: parsed.originalReference ?? null,
        outlookDraftId: parsed.outlookDraftId ?? null,
        replyToMessageId: parsed.replyToMessageId ?? null,
        replySubject: parsed.replySubject ?? null,
        rceDraftEnabled: parsed.rceDraftEnabled !== false,
        rceSecondSent: parsed.rceSecondSent === true,
      };
    }
  } catch {
    // Existing rows store their source reference as plain text.
  }
  return {
    originalReference: sourceReference,
    outlookDraftId: null,
    replyToMessageId: null,
    replySubject: null,
    rceDraftEnabled: true,
    rceSecondSent: false,
  };
}

export function writeWeeklyOutreachSourceMetadata(
  metadata: WeeklyOutreachSourceMetadata,
): string | null {
  if (
    !metadata.outlookDraftId &&
    !metadata.replyToMessageId &&
    !metadata.replySubject &&
    metadata.rceDraftEnabled &&
    !metadata.rceSecondSent
  ) {
    return metadata.originalReference;
  }
  return JSON.stringify({ weeklyOutreachMetadata: true, ...metadata });
}

export function withWeeklyOutreachClientMetadata(
  item: WeeklyOutreachItem,
): WeeklyOutreachItem {
  const metadata = readWeeklyOutreachSourceMetadata(item.source_reference);
  return {
    ...item,
    rce_draft_enabled: metadata.rceDraftEnabled,
    rce_second_sent: metadata.rceSecondSent,
    outlook_draft_ready: Boolean(metadata.outlookDraftId),
    outlook_reply_subject: metadata.replySubject,
  };
}

type SalesforceAccountDetails = {
  accountId: string;
  accountName: string;
  accountUrl: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
  tier: string | null;
  groupName: string | null;
};

type SfCredentials = NonNullable<Awaited<ReturnType<typeof getValidCredentials>>>;
let cachedAccountFields: Set<string> | null = null;

function escapeSoql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function currentWeekStart(date = new Date()): string {
  return format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

export function followingWeekStart(weekStart: string): string {
  return format(addDays(new Date(`${weekStart}T12:00:00`), 7), "yyyy-MM-dd");
}

async function accountFields(credentials: SfCredentials): Promise<Set<string>> {
  if (cachedAccountFields) return cachedAccountFields;
  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Account/describe`,
    { headers: { Authorization: `Bearer ${credentials.access_token}` } },
  );
  if (!response.ok) return new Set();
  const data = (await response.json()) as { fields?: Array<{ name: string }> };
  cachedAccountFields = new Set((data.fields ?? []).map((f) => f.name));
  return cachedAccountFields;
}

async function queryAccounts(
  credentials: SfCredentials,
  where: string,
  limit = 10,
): Promise<SalesforceAccountDetails[]> {
  const available = await accountFields(credentials);
  const optional = ["Group__c", "Tier__c", "Stage__c"].filter((f) =>
    available.has(f),
  );
  const fields = [
    "Id",
    "Name",
    "Website",
    "Industry",
    "BillingCountry",
    "BillingCity",
    ...optional,
  ];
  const soql = `SELECT ${fields.join(", ")} FROM Account WHERE ${where} ORDER BY Name ASC LIMIT ${limit}`;
  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/query/?q=${encodeURIComponent(soql)}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Salesforce account lookup failed: ${await response.text()}`);
  }
  const data = (await response.json()) as { records?: Array<Record<string, unknown>> };
  return (data.records ?? []).map((r) => ({
    accountId: String(r.Id),
    accountName: String(r.Name),
    accountUrl: `${credentials.instance_url}/${String(r.Id)}`,
    website: typeof r.Website === "string" ? r.Website : null,
    industry: typeof r.Industry === "string" ? r.Industry : null,
    country: typeof r.BillingCountry === "string" ? r.BillingCountry : null,
    city: typeof r.BillingCity === "string" ? r.BillingCity : null,
    tier:
      typeof r.Tier__c === "string"
        ? r.Tier__c
        : typeof r.Stage__c === "string"
          ? r.Stage__c
          : null,
    groupName: typeof r.Group__c === "string" ? r.Group__c : null,
  }));
}

export async function resolveWeeklyAccountByName(
  name: string,
): Promise<{ account: SalesforceAccountDetails | null; candidates: SalesforceAccountDetails[] }> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const candidates = await queryAccounts(
    credentials,
    `Name LIKE '%${escapeSoql(name.trim())}%'`,
  );
  const exact = candidates.find(
    (a) => a.accountName.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  return {
    account: exact ?? (candidates.length === 1 ? candidates[0] : null),
    candidates,
  };
}

export async function resolveWeeklyAccountById(
  accountId: string,
): Promise<SalesforceAccountDetails | null> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const rows = await queryAccounts(
    credentials,
    `Id = '${escapeSoql(accountId)}'`,
    1,
  );
  return rows[0] ?? null;
}

export function parseManualWeeklyEntry(raw: string): {
  outreachType: WeeklyOutreachType;
  accountName: string;
} | null {
  const match = raw.trim().match(/^(E1|RCE)\s+(.+)$/i);
  if (!match) return null;
  return {
    outreachType: match[1].toUpperCase() as WeeklyOutreachType,
    accountName: match[2].trim(),
  };
}

export async function upsertWeeklyOutreachItem(input: {
  weekStart?: string;
  outreachType: WeeklyOutreachType;
  account: SalesforceAccountDetails;
  source: WeeklyOutreachSource;
  sourceReference?: string | null;
  rceDays?: number | null;
}): Promise<WeeklyOutreachItem> {
  const supabase = getSupabaseAdmin();
  const payload = {
    week_start: input.weekStart ?? currentWeekStart(),
    outreach_type: input.outreachType,
    sf_account_id: input.account.accountId,
    account_name: input.account.accountName,
    account_url: input.account.accountUrl,
    website: input.account.website,
    industry: input.account.industry,
    country: input.account.country,
    city: input.account.city,
    tier: input.account.tier,
    group_name: input.account.groupName,
    source: input.source,
    source_reference: input.sourceReference ?? null,
    rce_days: input.rceDays ?? null,
  };
  const { data, error } = await supabase
    .from("weekly_outreach")
    .upsert(payload, { onConflict: "week_start,sf_account_id,outreach_type" })
    .select("*")
    .single();
  if (error) throw new Error(`Could not add to Weekly Outreach: ${error.message}`);
  return data as WeeklyOutreachItem;
}

export async function addAccountToWeeklyOutreach(input: {
  accountId: string;
  outreachType: WeeklyOutreachType;
  weekStart?: string;
  source: WeeklyOutreachSource;
  sourceReference?: string | null;
  rceDays?: number | null;
}): Promise<WeeklyOutreachItem> {
  const account = await resolveWeeklyAccountById(input.accountId);
  if (!account) throw new Error("Salesforce account was not found");
  return upsertWeeklyOutreachItem({ ...input, account });
}

export type WeeklyOutreachBatchEntry = {
  outreachType: WeeklyOutreachType;
  accountName: string;
};

export type WeeklyOutreachBatchResult = {
  index: number;
  item?: WeeklyOutreachItem;
  error?: string;
};

/** Resolve an Excel-style paste with one Salesforce query and one Supabase upsert. */
export async function addWeeklyOutreachBatch(input: {
  entries: WeeklyOutreachBatchEntry[];
  weekStart?: string;
  source: WeeklyOutreachSource;
}): Promise<WeeklyOutreachBatchResult[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const entries = input.entries.slice(0, 50).map((entry) => ({
    outreachType: entry.outreachType,
    accountName: entry.accountName.trim(),
  }));
  const uniqueNames = [...new Set(entries.map((entry) => entry.accountName.toLowerCase()))];
  const originalName = new Map(entries.map((entry) => [entry.accountName.toLowerCase(), entry.accountName]));
  const accounts: SalesforceAccountDetails[] = [];

  for (let index = 0; index < uniqueNames.length; index += 25) {
    const names = uniqueNames.slice(index, index + 25);
    const where = `Name IN (${names
      .map((name) => `'${escapeSoql(originalName.get(name) ?? name)}'`)
      .join(", ")})`;
    accounts.push(...(await queryAccounts(credentials, where, Math.min(200, names.length * 4))));
  }

  const matchesByName = new Map<string, SalesforceAccountDetails[]>();
  for (const account of accounts) {
    const key = account.accountName.trim().toLowerCase();
    const matches = matchesByName.get(key) ?? [];
    matches.push(account);
    matchesByName.set(key, matches);
  }

  const pending: Array<{
    index: number;
    entry: WeeklyOutreachBatchEntry;
    account: SalesforceAccountDetails;
  }> = [];
  const results: WeeklyOutreachBatchResult[] = [];
  entries.forEach((entry, index) => {
    if (!entry.accountName || !["E1", "RCE"].includes(entry.outreachType)) {
      results.push({ index, error: "Each row needs E1 or RCE and a company name." });
      return;
    }
    const matches = matchesByName.get(entry.accountName.toLowerCase()) ?? [];
    if (matches.length !== 1) {
      results.push({
        index,
        error:
          matches.length === 0
            ? "No exact Salesforce account matched."
            : "More than one Salesforce account has this exact name.",
      });
      return;
    }
    pending.push({ index, entry, account: matches[0] });
  });

  if (pending.length === 0) return results.sort((a, b) => a.index - b.index);

  const weekStart = input.weekStart ?? currentWeekStart();
  const uniquePayloads = new Map<string, Record<string, unknown>>();
  for (const row of pending) {
    const key = `${row.account.accountId}:${row.entry.outreachType}`;
    uniquePayloads.set(key, {
      week_start: weekStart,
      outreach_type: row.entry.outreachType,
      sf_account_id: row.account.accountId,
      account_name: row.account.accountName,
      account_url: row.account.accountUrl,
      website: row.account.website,
      industry: row.account.industry,
      country: row.account.country,
      city: row.account.city,
      tier: row.account.tier,
      group_name: row.account.groupName,
      source: input.source,
      source_reference: null,
      rce_days: null,
    });
  }
  const { data, error } = await getSupabaseAdmin()
    .from("weekly_outreach")
    .upsert([...uniquePayloads.values()], {
      onConflict: "week_start,sf_account_id,outreach_type",
    })
    .select("*");
  if (error) throw new Error(`Could not paste Weekly Outreach rows: ${error.message}`);

  const savedByKey = new Map<string, WeeklyOutreachItem>();
  for (const item of (data ?? []) as WeeklyOutreachItem[]) {
    savedByKey.set(`${item.sf_account_id}:${item.outreach_type}`, item);
  }
  for (const row of pending) {
    const item = savedByKey.get(`${row.account.accountId}:${row.entry.outreachType}`);
    results.push(
      item
        ? { index: row.index, item }
        : { index: row.index, error: "The row could not be saved." },
    );
  }
  return results.sort((a, b) => a.index - b.index);
}
