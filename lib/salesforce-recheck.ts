import { getValidCredentials } from "./token-manager";

// ── Re-Contact Checker ────────────────────────────────────────────────────────
//
// Takes a pasted list of company names and reports, for each one, the date of
// the last *logged Task* on the matching Salesforce Account (calls, logged
// emails, to-dos — NOT meetings/events), how long ago that was, the owner, and a
// direct link. Anything quiet for RECONTACT_THRESHOLD_DAYS+ is flagged as ready
// to re-contact.

// Days of silence after which an account is worth a fresh email. Single source
// of truth — change here to retune the flag everywhere.
export const RECONTACT_THRESHOLD_DAYS = 60;

// How many name searches to run against Salesforce at once. Keeps a 30-name
// paste fast without hammering the API.
const MATCH_CONCURRENCY = 6;

export type RecheckStatus = "matched" | "multiple" | "not_found";

export type RecheckRow = {
  input: string; // the company name exactly as the user pasted it
  status: RecheckStatus;
  accountId: string | null;
  accountName: string | null; // the matched Salesforce account name
  accountUrl: string | null; // link to the account in Salesforce
  owner: string | null;
  matchCount: number; // how many candidate accounts the name matched
  lastTaskDate: string | null; // ISO date e.g. "2025-09-12", null if no tasks logged
  daysSince: number | null; // days since lastTaskDate, null if no tasks logged
  readyToRecontact: boolean; // true when quiet >= threshold (or never contacted)
};

type SfAccount = {
  Id: string;
  Name: string;
  Owner?: { Name?: string | null } | null;
};

// SOQL string-literal escaping: backslash first, then single quote. Without this
// a name like "O'Brien" would break the query (and is an injection vector).
function escapeSoql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function sfQuery<T>(soql: string): Promise<T[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

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
    throw new Error(`Salesforce query failed: ${err}`);
  }

  const data = (await response.json()) as { records?: T[] };
  return data.records ?? [];
}

// The instance URL is needed to build account links. Fetched once and reused.
async function getInstanceUrl(): Promise<string> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  return credentials.instance_url;
}

type NameMatch = {
  input: string;
  status: RecheckStatus;
  account: SfAccount | null; // the chosen candidate (null when not found)
  matchCount: number;
};

// Find the best-matching account for a single name.
async function matchOneName(input: string): Promise<NameMatch> {
  const soql =
    `SELECT Id, Name, Owner.Name FROM Account ` +
    `WHERE Name LIKE '%${escapeSoql(input)}%' ` +
    `ORDER BY Name ASC LIMIT 5`;

  const records = await sfQuery<SfAccount>(soql);

  if (records.length === 0) {
    return { input, status: "not_found", account: null, matchCount: 0 };
  }

  // Prefer an exact (case-insensitive) name match if present — handles the case
  // where a short name like "Acme" also matches "Acme Holdings".
  const exact = records.find(
    (r) => r.Name.trim().toLowerCase() === input.trim().toLowerCase()
  );
  if (exact) {
    return { input, status: "matched", account: exact, matchCount: records.length };
  }

  if (records.length === 1) {
    return { input, status: "matched", account: records[0], matchCount: 1 };
  }

  // Several candidates, none exact — surface the closest (first alphabetically)
  // but flag it so the user verifies via the Salesforce link.
  return { input, status: "multiple", account: records[0], matchCount: records.length };
}

// Run name searches with bounded concurrency, preserving input order.
async function matchAccountsByNames(names: string[]): Promise<NameMatch[]> {
  const results: NameMatch[] = new Array(names.length);
  let cursor = 0;

  async function worker() {
    while (cursor < names.length) {
      const i = cursor++;
      results[i] = await matchOneName(names[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(MATCH_CONCURRENCY, names.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// Last logged-Task date per matched account. WhatId ties a Task to its Account.
// Returns accountId -> ISO date.
//
// Salesforce won't allow MAX(ActivityDate) (that field rejects aggregate
// operators in this org), so instead we pull tasks newest-first and keep the
// first (= latest) one we see per account. Results are paginated; we follow
// nextRecordsUrl and stop early once every account has a date.
async function lastTaskDatesForAccounts(
  accountIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (accountIds.length === 0) return map;

  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const idList = accountIds.map((id) => `'${escapeSoql(id)}'`).join(",");
  const soql =
    `SELECT WhatId, ActivityDate ` +
    `FROM Task ` +
    `WHERE WhatId IN (${idList}) AND ActivityDate != null ` +
    `ORDER BY ActivityDate DESC`;

  type Row = { WhatId: string; ActivityDate: string };
  type QueryResponse = {
    records?: Row[];
    done?: boolean;
    nextRecordsUrl?: string;
  };

  let url: string | null =
    `${credentials.instance_url}/services/data/v62.0/query/?q=${encodeURIComponent(soql)}`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Salesforce query failed: ${err}`);
    }

    const data = (await response.json()) as QueryResponse;
    for (const r of data.records ?? []) {
      // Ordered DESC, so the first time we see an account is its latest task.
      if (r.WhatId && r.ActivityDate && !map.has(r.WhatId)) {
        map.set(r.WhatId, r.ActivityDate);
      }
    }

    // Stop once every account has a date, or there are no more pages.
    if (map.size >= accountIds.length || data.done || !data.nextRecordsUrl) {
      break;
    }
    url = `${credentials.instance_url}${data.nextRecordsUrl}`;
  }

  return map;
}

function daysBetween(fromIso: string, now: Date): number {
  const ms = now.getTime() - new Date(fromIso + "T00:00:00").getTime();
  return Math.floor(ms / 86_400_000);
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function checkRecontact(names: string[]): Promise<RecheckRow[]> {
  const matches = await matchAccountsByNames(names);
  const instanceUrl = await getInstanceUrl();

  const matchedIds = Array.from(
    new Set(
      matches
        .filter((m) => m.account !== null)
        .map((m) => m.account!.Id)
    )
  );
  const lastTaskByAccount = await lastTaskDatesForAccounts(matchedIds);

  const now = new Date();

  return matches.map((m) => {
    if (!m.account) {
      return {
        input: m.input,
        status: m.status,
        accountId: null,
        accountName: null,
        accountUrl: null,
        owner: null,
        matchCount: m.matchCount,
        lastTaskDate: null,
        daysSince: null,
        readyToRecontact: false,
      };
    }

    const lastTaskDate = lastTaskByAccount.get(m.account.Id) ?? null;
    const daysSince = lastTaskDate ? daysBetween(lastTaskDate, now) : null;
    // Never-contacted (no logged task) counts as ready; otherwise gate on the
    // threshold. Multiple-match rows still compute a value but stay flagged.
    const readyToRecontact =
      lastTaskDate === null || (daysSince ?? 0) >= RECONTACT_THRESHOLD_DAYS;

    return {
      input: m.input,
      status: m.status,
      accountId: m.account.Id,
      accountName: m.account.Name,
      accountUrl: `${instanceUrl}/${m.account.Id}`,
      owner: m.account.Owner?.Name ?? null,
      matchCount: m.matchCount,
      lastTaskDate,
      daysSince,
      readyToRecontact,
    };
  });
}
