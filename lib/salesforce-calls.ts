import { getValidCredentials } from "./token-manager";
import { assertSalesforceId, isSalesforceId, sfErrorText, sfFetch, sfQuery } from "./sf-query";
import {
  accountWhereClause,
  escapeSoql,
  exactNameWhereClause,
  mergeAccountsById,
  parseAccountQuery,
  rankAccounts,
} from "./account-match";
import { format, addDays } from "date-fns";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SalesforceAccountMatch = {
  accountId: string;
  accountName: string;
  accountUrl: string; // link to the account in Salesforce
  website: string | null;
};

// ── Find Salesforce Accounts by website domain ────────────────────────────────

export async function findAccountByDomain(
  domain: string
): Promise<SalesforceAccountMatch | null> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Salesforce stores websites like "https://www.certaintysoftware.com/"
  // We search with LIKE to match regardless of trailing slashes or protocol
  const query = `SELECT Id, Name, Website FROM Account WHERE Website LIKE '%${escapeSoql(domain)}%' LIMIT 1`;

  const records = await sfQuery<{ Id: string; Name: string; Website?: string }>(
    query,
    credentials
  );

  if (records.length === 0) return null;

  const r = records[0];
  return {
    accountId: r.Id,
    accountName: r.Name,
    accountUrl: `${credentials.instance_url}/${r.Id}`,
    website: r.Website ?? null,
  };
}

export async function findAccountsByDomains(
  domains: string[],
): Promise<Map<string, SalesforceAccountMatch>> {
  const clean = Array.from(new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean)));
  const matches = new Map<string, SalesforceAccountMatch>();
  if (clean.length === 0) return matches;
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const escapeSoql = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const where = clean.map((d) => `Website LIKE '%${escapeSoql(d)}%'`).join(" OR ");
  const soql = `SELECT Id, Name, Website FROM Account WHERE ${where} ORDER BY Name ASC LIMIT 2000`;
  const records = await sfQuery<{ Id: string; Name: string; Website?: string }>(soql, credentials);
  for (const domain of clean) {
    const row = records.find((r) => (r.Website ?? "").toLowerCase().includes(domain));
    if (row) matches.set(domain, {
      accountId: row.Id,
      accountName: row.Name,
      accountUrl: `${credentials.instance_url}/${row.Id}`,
      website: row.Website ?? null,
    });
  }
  return matches;
}

// ── Check for existing call tasks in a date range ────────────────────────────

export async function findExistingCallTasks(
  accountIds: string[],
  startDate: string,
  endDate: string,
  /** Only count this call type ("C1" or "RCC"); both when omitted. */
  subjectType?: "C1" | "RCC",
): Promise<Set<string>> {
  // Only well-formed ids and yyyy-MM-dd dates reach the query: these come
  // from the browser, and a stray quote would break (or bend) the SOQL.
  const ids = accountIds.filter(isSalesforceId);
  if (ids.length === 0) return new Set();
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(startDate) || !isoDate.test(endDate)) {
    throw new Error("Invalid date range");
  }

  const idList = ids.map((id) => `'${id}'`).join(",");
  const query = `SELECT Id, WhatId FROM Task WHERE WhatId IN (${idList}) AND ActivityDate >= ${startDate} AND ActivityDate <= ${endDate} AND Status = 'Completed' AND ${
    subjectType
      ? `Subject_Type__c = '${subjectType === "RCC" ? "RCC" : "C1"}'`
      : "(Subject_Type__c = 'C1' OR Subject_Type__c = 'RCC')"
  }`;

  let records: Array<{ WhatId: string }>;
  try {
    records = await sfQuery<{ WhatId: string }>(query);
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_CONNECTED") throw err;
    return new Set(); // fail silently — feature is non-critical
  }

  // Return set of accountIds that have existing call tasks
  return new Set(records.map((r) => r.WhatId));
}

// ── Search Salesforce Accounts by name ───────────────────────────────────────

export async function searchAccountsByName(
  searchQuery: string
): Promise<SalesforceAccountMatch[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // A plain `LIKE '%q%' ... LIMIT 10` sorted by name buries short names
  // ("ITS") under everything that merely contains the letters. Pull a wider
  // set, rank exact > starts-with > whole word > contains, and let a pasted
  // URL match on the Website domain. See lib/account-match.ts.
  const parsed = parseAccountQuery(searchQuery);
  const query = `SELECT Id, Name, Website FROM Account WHERE ${accountWhereClause(parsed)} ORDER BY Name ASC LIMIT 200`;
  const exactWhere = exactNameWhereClause(parsed);

  type Row = { Id: string; Name: string; Website?: string };
  const [exactRecords, records] = await Promise.all([
    exactWhere
      ? sfQuery<Row>(`SELECT Id, Name, Website FROM Account WHERE ${exactWhere} LIMIT 20`, credentials)
      : Promise.resolve([] as Row[]),
    sfQuery<Row>(query, credentials),
  ]);

  const accounts: SalesforceAccountMatch[] = [...exactRecords, ...records].map((r) => ({
    accountId: r.Id,
    accountName: r.Name,
    accountUrl: `${credentials.instance_url}/${r.Id}`,
    website: r.Website ?? null,
  }));

  return rankAccounts(parsed, mergeAccountsById(accounts))
    .slice(0, 10)
    .map(({ matchScore: _score, ...rest }) => rest);
}

// ── Create a completed call task (C1 or RCC) ─────────────────────────────────

export async function createCompletedCallTask(params: {
  accountId: string;
  subject: string;
  subjectType: string; // "C1" or "RCC"
  meetingDate: string; // ISO date: "2026-03-05"
}): Promise<string> {
  assertSalesforceId(params.accountId, "account id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const response = await sfFetch(
    `/services/data/v62.0/sobjects/Task`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Subject: params.subject,
        Type: params.subjectType,
        Subject_Type__c: params.subjectType,
        Status: "Completed",
        ActivityDate: params.meetingDate,
        WhatId: params.accountId,
        OwnerId: credentials.salesforce_user_id,
      }),
    },
    credentials,
  );

  if (!response.ok) {
    const err = await sfErrorText(response);
    throw new Error(`Failed to create call task: ${err}`);
  }

  const result = await response.json();
  return result.id; // newly created task ID
}

// ── Create or move the open follow-up task (RCE) ─────────────────────────────

export type FollowUpOutcome = {
  action: "created" | "moved";
  taskId: string;
  date: string; // yyyy-MM-dd
  /** For "moved": where the task was due before. */
  previousDate: string | null;
};

/**
 * "RCE30" means "the next touch is 30 days out". If the account already has
 * an open reconnect task, that task is moved to the new date rather than a
 * second one being created next to it (which is what used to happen, leaving
 * the old date in place). With no open task, one is created.
 */
export async function upsertFollowUpTask(params: {
  accountId: string;
  subject: string;
  subjectType: string; // e.g. "RCE1"
  meetingDate: string; // ISO date of the original meeting
  daysFromMeeting: number; // e.g. 14 for RCE14
}): Promise<FollowUpOutcome> {
  assertSalesforceId(params.accountId, "account id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const followUpDate = format(
    addDays(new Date(params.meetingDate), params.daysFromMeeting),
    "yyyy-MM-dd"
  );

  // Earliest open task on the account owned by the user. Any open task
  // counts (RCE, "Reconnect Call", or whatever it was named): there should
  // only ever be one next step per account.
  const openTasks = await sfQuery<{ Id: string; ActivityDate: string | null; Subject: string }>(
    `SELECT Id, ActivityDate, Subject FROM Task ` +
      `WHERE WhatId = '${params.accountId}' ` +
      `AND IsClosed = false ` +
      `AND OwnerId = '${credentials.salesforce_user_id}' ` +
      `ORDER BY ActivityDate ASC NULLS LAST LIMIT 5`,
    credentials
  );

  if (openTasks.length > 0) {
    const existing = openTasks[0];
    const response = await sfFetch(
      `/services/data/v62.0/sobjects/Task/${existing.Id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ActivityDate: followUpDate }),
      },
      credentials,
    );
    if (!response.ok && response.status !== 204) {
      throw new Error(`Failed to move follow-up task: ${await sfErrorText(response)}`);
    }
    return {
      action: "moved",
      taskId: existing.Id,
      date: followUpDate,
      previousDate: existing.ActivityDate,
    };
  }

  const response = await sfFetch(
    `/services/data/v62.0/sobjects/Task`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Subject: params.subject,
        Subject_Type__c: params.subjectType,
        Status: "Open",
        Priority: "Normal",
        ActivityDate: followUpDate,
        WhatId: params.accountId,
        OwnerId: credentials.salesforce_user_id,
      }),
    },
    credentials,
  );

  if (!response.ok) {
    const err = await sfErrorText(response);
    throw new Error(`Failed to create follow-up task: ${err}`);
  }

  const result = await response.json();
  return { action: "created", taskId: result.id, date: followUpDate, previousDate: null };
}

// ── Create a ContentNote linked to an Account ─────────────────────────────────

export async function createAccountNote(params: {
  accountId: string;
  title: string; // e.g. "C1 Notes" or "RCC Notes"
  content: string; // plain text content (Granola meeting notes)
}): Promise<string> {
  assertSalesforceId(params.accountId, "account id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Step 1: Create the ContentNote
  // Salesforce ContentNote expects the Content field as base64-encoded HTML
  const htmlContent = params.content
    .split("\n")
    .map((line) => `<p>${line || "&nbsp;"}</p>`)
    .join("");
  const base64Content = Buffer.from(htmlContent).toString("base64");

  const noteResponse = await sfFetch(
    `/services/data/v62.0/sobjects/ContentNote`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Title: params.title,
        Content: base64Content,
      }),
    },
    credentials,
  );

  if (!noteResponse.ok) {
    const err = await sfErrorText(noteResponse);
    throw new Error(`Failed to create note: ${err}`);
  }

  const noteResult = await noteResponse.json();
  const contentDocumentId = noteResult.id;

  // Step 2: Link the note to the Account via ContentDocumentLink
  const linkResponse = await sfFetch(
    `/services/data/v62.0/sobjects/ContentDocumentLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ContentDocumentId: contentDocumentId,
        LinkedEntityId: params.accountId,
        ShareType: "V", // Viewer access
        Visibility: "AllUsers",
      }),
    },
    credentials,
  );

  if (!linkResponse.ok) {
    const err = await sfErrorText(linkResponse);
    throw new Error(`Failed to link note to account: ${err}`);
  }

  return contentDocumentId;
}
