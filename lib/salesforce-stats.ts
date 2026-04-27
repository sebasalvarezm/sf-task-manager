import { SfCredentials } from "./supabase";
import { Bucket } from "./date-ranges";

// ── Hardcoded CDM group (per product direction) ──────────────────────────────
export const CDM_OWNER_NAMES = [
  "Sebastian Alvarez",
  "Nate Sabb",
  "Tyson Hasegawa-Foster",
] as const;

export const TRACKED_SUBJECT_TYPES = ["E1", "RCE1", "C1", "RCC", "F2F"] as const;
// Display order for the BRO pipeline chart and drill-down groupings.
// IOI/LOI come before DD because that matches how the team thinks about the
// funnel (initial offer happens before deep diligence in M&A workflow).
export const OPPORTUNITY_STAGES = [
  "Incoming",
  "Pre-DD",
  "IOI",
  "LOI",
  "DD",
  "On Ice",
] as const;

// Salesforce stores BRO amounts in thousands — 500 = $500K, 1500 = $1.5M.
// Multiply raw Opportunity.Amount values by this before formatting.
const BRO_AMOUNT_MULTIPLIER = 1000;

export type TrackedSubjectType = (typeof TRACKED_SUBJECT_TYPES)[number];
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export type TaskCountRow = {
  owner: string;
  type: TrackedSubjectType;
  count: number;
};

export type BucketCountRow = {
  bucketLabel: string;
  bucketStart: string;
  e1: number;
  rce1: number;
  c1: number;
  rcc: number;
  f2f: number;
};

export type StageTotalRow = {
  stage: OpportunityStage;
  total: number;
};

export type OriginatorTotalRow = {
  owner: string;
  total: number;
};

export type StuckOpportunity = {
  id: string;
  name: string;
  accountName: string;
  stage: OpportunityStage;
  amount: number;        // already multiplied by BRO_AMOUNT_MULTIPLIER
  daysStuck: number;
  lastStageChangeDate: string; // ISO date
  owner: string;
};

// ── SOQL helpers ─────────────────────────────────────────────────────────────

function escapeSoql(v: string): string {
  return v.replace(/'/g, "\\'");
}

const ownerNamesClause = CDM_OWNER_NAMES.map((n) => `'${escapeSoql(n)}'`).join(",");
const subjectTypesClause = TRACKED_SUBJECT_TYPES.map((t) => `'${t}'`).join(",");
const stagesClause = OPPORTUNITY_STAGES.map((s) => `'${escapeSoql(s)}'`).join(",");

async function runQuery<T>(
  credentials: SfCredentials,
  soql: string
): Promise<T[]> {
  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/query/?q=${encodeURIComponent(soql)}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Salesforce stats query failed: ${err}`);
  }

  const data = (await response.json()) as { records?: T[] };
  return data.records ?? [];
}

// ── Task counts for a single range, grouped by owner + subject type ──────────

export async function fetchTaskCountsForRange(
  credentials: SfCredentials,
  rangeStart: string,
  rangeEnd: string
): Promise<TaskCountRow[]> {
  const soql =
    `SELECT Owner.Name ownerName, Subject_Type__c stype, COUNT(Id) cnt ` +
    `FROM Task ` +
    `WHERE Subject_Type__c IN (${subjectTypesClause}) ` +
    `AND Status = 'Completed' ` +
    `AND ActivityDate >= ${rangeStart} AND ActivityDate <= ${rangeEnd} ` +
    `AND Owner.Name IN (${ownerNamesClause}) ` +
    `GROUP BY Owner.Name, Subject_Type__c`;

  type Row = { ownerName: string; stype: TrackedSubjectType; cnt: number };
  const rows = await runQuery<Row>(credentials, soql);

  return rows.map((r) => ({
    owner: r.ownerName,
    type: r.stype,
    count: Number(r.cnt) || 0,
  }));
}

// ── Task counts bucketed (one query per bucket, run in parallel) ─────────────

export async function fetchTaskCountsByBucket(
  credentials: SfCredentials,
  buckets: Bucket[]
): Promise<BucketCountRow[]> {
  if (buckets.length === 0) return [];

  const perBucket = await Promise.all(
    buckets.map(async (b) => {
      const soql =
        `SELECT Subject_Type__c stype, COUNT(Id) cnt ` +
        `FROM Task ` +
        `WHERE Subject_Type__c IN (${subjectTypesClause}) ` +
        `AND Status = 'Completed' ` +
        `AND ActivityDate >= ${b.start} AND ActivityDate <= ${b.end} ` +
        `AND Owner.Name IN (${ownerNamesClause}) ` +
        `GROUP BY Subject_Type__c`;

      type Row = { stype: TrackedSubjectType; cnt: number };
      const rows = await runQuery<Row>(credentials, soql);

      const byType: Record<TrackedSubjectType, number> = {
        E1: 0,
        RCE1: 0,
        C1: 0,
        RCC: 0,
        F2F: 0,
      };
      for (const r of rows) byType[r.stype] = Number(r.cnt) || 0;

      return {
        bucketLabel: b.label,
        bucketStart: b.start,
        e1: byType.E1,
        rce1: byType.RCE1,
        c1: byType.C1,
        rcc: byType.RCC,
        f2f: byType.F2F,
      };
    })
  );

  return perBucket;
}

// ── Open opportunities summed by stage ───────────────────────────────────────

export async function fetchOpportunitiesByStage(
  credentials: SfCredentials
): Promise<StageTotalRow[]> {
  const soql =
    `SELECT StageName stage, SUM(Amount) total ` +
    `FROM Opportunity ` +
    `WHERE StageName IN (${stagesClause}) ` +
    `AND Owner.Name IN (${ownerNamesClause}) ` +
    `AND IsClosed = false ` +
    `GROUP BY StageName`;

  type Row = { stage: OpportunityStage; total: number | null };
  const rows = await runQuery<Row>(credentials, soql);

  const byStage = new Map<OpportunityStage, number>();
  for (const r of rows) byStage.set(r.stage, Number(r.total) || 0);

  return OPPORTUNITY_STAGES.map((s) => ({
    stage: s,
    total: (byStage.get(s) ?? 0) * BRO_AMOUNT_MULTIPLIER,
  }));
}

// ── Open BRO by originator (Owner.Name) ──────────────────────────────────────

export async function fetchOpenBROByOriginator(
  credentials: SfCredentials
): Promise<OriginatorTotalRow[]> {
  const soql =
    `SELECT Owner.Name ownerName, SUM(Amount) total ` +
    `FROM Opportunity ` +
    `WHERE StageName IN (${stagesClause}) ` +
    `AND Owner.Name IN (${ownerNamesClause}) ` +
    `AND IsClosed = false ` +
    `GROUP BY Owner.Name`;

  type Row = { ownerName: string; total: number | null };
  const rows = await runQuery<Row>(credentials, soql);

  const byOwner = new Map<string, number>();
  for (const r of rows) byOwner.set(r.ownerName, Number(r.total) || 0);

  return CDM_OWNER_NAMES.map((n) => ({
    owner: n,
    total: (byOwner.get(n) ?? 0) * BRO_AMOUNT_MULTIPLIER,
  }));
}

// ── Stuck opportunities (30+ days in stage) ──────────────────────────────────

export async function fetchStuckOpportunities(
  credentials: SfCredentials,
  thresholdDays: number = 30,
  limit: number = 20
): Promise<StuckOpportunity[]> {
  const soql =
    `SELECT Id, Name, StageName, Amount, LastModifiedDate, Account.Name, Owner.Name ` +
    `FROM Opportunity ` +
    `WHERE IsClosed = false ` +
    `AND StageName IN (${stagesClause}) ` +
    `AND Owner.Name IN (${ownerNamesClause}) ` +
    `ORDER BY LastModifiedDate ASC ` +
    `LIMIT 200`;

  type Row = {
    Id: string;
    Name: string;
    StageName: OpportunityStage;
    Amount: number | null;
    LastModifiedDate: string;
    Account?: { Name?: string } | null;
    Owner?: { Name?: string } | null;
  };

  const rows = await runQuery<Row>(credentials, soql);

  const now = Date.now();
  const stuck: StuckOpportunity[] = [];

  for (const r of rows) {
    if (!r.LastModifiedDate) continue;
    const changeMs = new Date(r.LastModifiedDate).getTime();
    const daysStuck = Math.floor((now - changeMs) / (1000 * 60 * 60 * 24));
    if (daysStuck < thresholdDays) continue;

    stuck.push({
      id: r.Id,
      name: r.Name,
      accountName: r.Account?.Name ?? "(no account)",
      stage: r.StageName,
      amount: (Number(r.Amount) || 0) * BRO_AMOUNT_MULTIPLIER,
      daysStuck,
      lastStageChangeDate: r.LastModifiedDate,
      owner: r.Owner?.Name ?? "",
    });
  }

  stuck.sort((a, b) => b.daysStuck - a.daysStuck);
  return stuck.slice(0, limit);
}

// ── Drill helpers (per-company breakdown for chart bar clicks) ───────────────

export type DrillAccountRow = {
  accountId: string | null;
  accountName: string;
  website: string | null;
  numberOfEmployees: number | null;
  country: string | null;
  lastActivityDate: string | null;
  // populated only for opportunity-based drills
  opportunityId?: string | null;
  opportunityName?: string | null;
  stage?: string | null;
  amount?: number | null;
};

type RawTaskAccountRow = {
  Id: string;
  ActivityDate: string | null;
  Subject_Type__c?: string | null;
  AccountId: string | null;
  Account: {
    Name?: string | null;
    Website?: string | null;
    NumberOfEmployees?: number | null;
    BillingCountry?: string | null;
  } | null;
};

/**
 * Generic task-based drill. Returns deduped accounts (most-recent activity
 * wins) matching subject types + owner + date window.
 */
export async function fetchDrillAccountsForTasks(
  credentials: SfCredentials,
  options: {
    types: TrackedSubjectType[];
    ownerName: string;
    rangeStart: string;
    rangeEnd: string;
    limit?: number;
  }
): Promise<DrillAccountRow[]> {
  const { types, ownerName, rangeStart, rangeEnd, limit = 500 } = options;
  if (types.length === 0) return [];

  const typesClause = types.map((t) => `'${t}'`).join(",");
  const soql =
    `SELECT Id, ActivityDate, Subject_Type__c, AccountId, ` +
    `Account.Name, Account.Website, Account.NumberOfEmployees, Account.BillingCountry ` +
    `FROM Task ` +
    `WHERE Subject_Type__c IN (${typesClause}) ` +
    `AND Status = 'Completed' ` +
    `AND ActivityDate >= ${rangeStart} AND ActivityDate <= ${rangeEnd} ` +
    `AND Owner.Name = '${escapeSoql(ownerName)}' ` +
    `AND AccountId != null ` +
    `ORDER BY ActivityDate DESC ` +
    `LIMIT ${limit}`;

  const rows = await runQuery<RawTaskAccountRow>(credentials, soql);

  // Dedupe by AccountId — most recent task wins (SOQL ORDER BY ActivityDate DESC).
  const seen = new Set<string>();
  const out: DrillAccountRow[] = [];
  for (const r of rows) {
    const id = r.AccountId ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      accountId: r.AccountId,
      accountName: r.Account?.Name ?? "(no account)",
      website: r.Account?.Website ?? null,
      numberOfEmployees: r.Account?.NumberOfEmployees ?? null,
      country: r.Account?.BillingCountry ?? null,
      lastActivityDate: r.ActivityDate ?? null,
    });
  }
  return out;
}

type RawOppRow = {
  Id: string;
  Name: string;
  StageName: string;
  Amount: number | null;
  AccountId: string | null;
  Account: {
    Name?: string | null;
    Website?: string | null;
    NumberOfEmployees?: number | null;
    BillingCountry?: string | null;
  } | null;
  LastModifiedDate: string;
};

function oppToDrillRow(r: RawOppRow): DrillAccountRow {
  return {
    accountId: r.AccountId,
    accountName: r.Account?.Name ?? "(no account)",
    website: r.Account?.Website ?? null,
    numberOfEmployees: r.Account?.NumberOfEmployees ?? null,
    country: r.Account?.BillingCountry ?? null,
    lastActivityDate: r.LastModifiedDate,
    opportunityId: r.Id,
    opportunityName: r.Name,
    stage: r.StageName,
    amount: (Number(r.Amount) || 0) * BRO_AMOUNT_MULTIPLIER,
  };
}

/** Open BROs originated by a specific CDM owner. */
export async function fetchDrillOppsByOriginator(
  credentials: SfCredentials,
  ownerName: string
): Promise<DrillAccountRow[]> {
  const soql =
    `SELECT Id, Name, StageName, Amount, LastModifiedDate, AccountId, ` +
    `Account.Name, Account.Website, Account.NumberOfEmployees, Account.BillingCountry ` +
    `FROM Opportunity ` +
    `WHERE IsClosed = false ` +
    `AND StageName IN (${stagesClause}) ` +
    `AND Owner.Name = '${escapeSoql(ownerName)}' ` +
    `ORDER BY Amount DESC NULLS LAST ` +
    `LIMIT 200`;
  const rows = await runQuery<RawOppRow>(credentials, soql);
  return rows.map(oppToDrillRow);
}

/** Open BROs in a specific stage (across all CDM owners). */
export async function fetchDrillOppsByStage(
  credentials: SfCredentials,
  stage: string
): Promise<DrillAccountRow[]> {
  const soql =
    `SELECT Id, Name, StageName, Amount, LastModifiedDate, AccountId, ` +
    `Account.Name, Account.Website, Account.NumberOfEmployees, Account.BillingCountry ` +
    `FROM Opportunity ` +
    `WHERE IsClosed = false ` +
    `AND StageName = '${escapeSoql(stage)}' ` +
    `AND Owner.Name IN (${ownerNamesClause}) ` +
    `ORDER BY Amount DESC NULLS LAST ` +
    `LIMIT 200`;
  const rows = await runQuery<RawOppRow>(credentials, soql);
  return rows.map(oppToDrillRow);
}

// ── F2F This Year (always YTD, regardless of selected range) ─────────────────

export async function fetchF2FThisYear(credentials: SfCredentials): Promise<number> {
  const soql =
    `SELECT COUNT(Id) cnt ` +
    `FROM Task ` +
    `WHERE Subject_Type__c = 'F2F' ` +
    `AND Status = 'Completed' ` +
    `AND ActivityDate = THIS_YEAR ` +
    `AND Owner.Name IN (${ownerNamesClause})`;

  type Row = { cnt: number };
  const rows = await runQuery<Row>(credentials, soql);
  return rows.length > 0 ? Number(rows[0].cnt) || 0 : 0;
}
