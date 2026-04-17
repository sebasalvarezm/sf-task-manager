import { getValidCredentials } from "./token-manager";
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
  const query = encodeURIComponent(
    `SELECT Id, Name, Website FROM Account WHERE Website LIKE '%${domain}%' LIMIT 1`
  );

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/query/?q=${query}`,
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

  const data = await response.json();
  const records = data.records ?? [];

  if (records.length === 0) return null;

  const r = records[0];
  return {
    accountId: r.Id,
    accountName: r.Name,
    accountUrl: `${credentials.instance_url}/${r.Id}`,
    website: r.Website ?? null,
  };
}

// ── Check for existing call tasks in a date range ────────────────────────────

export async function findExistingCallTasks(
  accountIds: string[],
  startDate: string,
  endDate: string
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();

  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const idList = accountIds.map((id) => `'${id}'`).join(",");
  const query = encodeURIComponent(
    `SELECT Id, WhatId FROM Task WHERE WhatId IN (${idList}) AND ActivityDate >= ${startDate} AND ActivityDate <= ${endDate} AND Status = 'Completed' AND (Subject_Type__c = 'C1' OR Subject_Type__c = 'RCC')`
  );

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/query/?q=${query}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) return new Set(); // fail silently — feature is non-critical

  const data = await response.json();
  const records = data.records ?? [];

  // Return set of accountIds that have existing call tasks
  return new Set(records.map((r: { WhatId: string }) => r.WhatId));
}

// ── Search Salesforce Accounts by name ───────────────────────────────────────

export async function searchAccountsByName(
  searchQuery: string
): Promise<SalesforceAccountMatch[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const query = encodeURIComponent(
    `SELECT Id, Name, Website FROM Account WHERE Name LIKE '%${searchQuery}%' ORDER BY Name ASC LIMIT 10`
  );

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/query/?q=${query}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Salesforce search failed: ${err}`);
  }

  const data = await response.json();
  return (data.records ?? []).map((r: { Id: string; Name: string; Website?: string }) => ({
    accountId: r.Id,
    accountName: r.Name,
    accountUrl: `${credentials.instance_url}/${r.Id}`,
    website: r.Website ?? null,
  }));
}

// ── Create a completed call task (C1 or RCC) ─────────────────────────────────

export async function createCompletedCallTask(params: {
  accountId: string;
  subject: string;
  subjectType: string; // "C1" or "RCC"
  meetingDate: string; // ISO date: "2026-03-05"
}): Promise<string> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Task`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
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
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create call task: ${err}`);
  }

  const result = await response.json();
  return result.id; // newly created task ID
}

// ── Create an open follow-up task (RCE) ──────────────────────────────────────

export async function createFollowUpTask(params: {
  accountId: string;
  subject: string;
  subjectType: string; // e.g. "RCE1"
  meetingDate: string; // ISO date of the original meeting
  daysFromMeeting: number; // e.g. 14 for RCE14
}): Promise<string> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const followUpDate = format(
    addDays(new Date(params.meetingDate), params.daysFromMeeting),
    "yyyy-MM-dd"
  );

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Task`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
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
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create follow-up task: ${err}`);
  }

  const result = await response.json();
  return result.id;
}

// ── Create a ContentNote linked to an Account ─────────────────────────────────

export async function createAccountNote(params: {
  accountId: string;
  title: string; // e.g. "C1 Notes" or "RCC Notes"
  content: string; // plain text content (Granola meeting notes)
}): Promise<string> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Step 1: Create the ContentNote
  // Salesforce ContentNote expects the Content field as base64-encoded HTML
  const htmlContent = params.content
    .split("\n")
    .map((line) => `<p>${line || "&nbsp;"}</p>`)
    .join("");
  const base64Content = Buffer.from(htmlContent).toString("base64");

  const noteResponse = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/ContentNote`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Title: params.title,
        Content: base64Content,
      }),
    }
  );

  if (!noteResponse.ok) {
    const err = await noteResponse.text();
    throw new Error(`Failed to create note: ${err}`);
  }

  const noteResult = await noteResponse.json();
  const contentDocumentId = noteResult.id;

  // Step 2: Link the note to the Account via ContentDocumentLink
  const linkResponse = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/ContentDocumentLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ContentDocumentId: contentDocumentId,
        LinkedEntityId: params.accountId,
        ShareType: "V", // Viewer access
        Visibility: "AllUsers",
      }),
    }
  );

  if (!linkResponse.ok) {
    const err = await linkResponse.text();
    throw new Error(`Failed to link note to account: ${err}`);
  }

  return contentDocumentId;
}
