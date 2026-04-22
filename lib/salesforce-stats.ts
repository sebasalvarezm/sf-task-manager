import { SfCredentials } from "./supabase";
import { Bucket } from "./date-ranges";

// ── Hardcoded CDM group (per product direction) ──────────────────────────────
export const CDM_OWNER_NAMES = [
  "Sebastian Alvarez",
  "Nate Sabb",
  "Tyson Hasegawa-Foster",
] as const;

export const TRACKED_SUBJECT_TYPES = ["E1", "RCE1", "C1", "F2F"] as const;
export const OPPORTUNITY_STAGES = [
  "Incoming",
  "Pre-DD",
  "DD",
  "On Ice",
  "IOI",
  "LOI",
] as const;

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
        F2F: 0,
      };
      for (const r of rows) byType[r.stype] = Number(r.cnt) || 0;

      return {
        bucketLabel: b.label,
        bucketStart: b.start,
        e1: byType.E1,
        rce1: byType.RCE1,
        c1: byType.C1,
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

  return OPPORTUNITY_STAGES.map((s) => ({ stage: s, total: byStage.get(s) ?? 0 }));
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

  return CDM_OWNER_NAMES.map((n) => ({ owner: n, total: byOwner.get(n) ?? 0 }));
}

// ── F2F This Year (always YTD, regardless of selected range) ─────────────────

export async function fetchF2FThisYear(credentials: SfCredentials): Promise<number> {
  const soql =
    `SELECT COUNT(Id) cnt ` +
    `FROM Task ` +
    `WHERE Subject_Type__c = 'F2F' ` +
    `AND Status = 'Completed' ` +
    `AND CALENDAR_YEAR(ActivityDate) = ${new Date().getFullYear()} ` +
    `AND Owner.Name IN (${ownerNamesClause})`;

  type Row = { cnt: number };
  const rows = await runQuery<Row>(credentials, soql);
  return rows.length > 0 ? Number(rows[0].cnt) || 0 : 0;
}
