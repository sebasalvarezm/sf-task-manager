import { getValidCredentials } from "./token-manager";
import { getSupabaseAdmin } from "./supabase";
import { assertSalesforceId, sfErrorText, sfFetch, sfQuery } from "./sf-query";
import { addDays, format } from "date-fns";
import { extractYear } from "./outreach-quality";

export type SalesforceTask = {
  Id: string;
  Subject: string;
  ActivityDate: string; // ISO date string: "2026-03-05"
  AccountId: string | null;
  AccountName: string | null;
  AccountUrl: string | null;
  AccountWebsite: string | null; // Company's own website (e.g. https://acme.com)
  /** From the account, for the "Pre-mark BS" sweep on the Tasks page. */
  AccountEmployees: number | null;
  AccountFounded: number | null;
  Priority: string;
};

// ── Fetch open tasks ─────────────────────────────────────────────────────────

export async function fetchOpenTasks(): Promise<SalesforceTask[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const userId = credentials.salesforce_user_id;
  if (!userId) throw new Error("NOT_CONNECTED");

  const query = (withFounded: boolean) =>
    `SELECT Id, Subject, ActivityDate, AccountId, Account.Name, Account.Website, Account.NumberOfEmployees` +
    (withFounded ? `, Account.Year_Established__c` : ``) +
    `, Priority ` +
    `FROM Task ` +
    `WHERE Status = 'Open' ` +
    `AND OwnerId = '${userId}' ` +
    `ORDER BY ActivityDate ASC NULLS FIRST`;

  type Raw = {
    Id: string;
    Subject: string;
    ActivityDate: string;
    AccountId: string | null;
    Account?: { Name: string; Website?: string | null; NumberOfEmployees?: number | null; Year_Established__c?: string | null } | null;
    Priority: string;
  };
  let records: Raw[];
  try {
    records = await sfQuery<Raw>(query(true), credentials);
  } catch (err) {
    // Year_Established__c is a custom field; fall back without it rather than fail the page.
    if (err instanceof Error && err.message === "NOT_CONNECTED") throw err;
    records = await sfQuery<Raw>(query(false), credentials);
  }

  return records.map(
    (r): SalesforceTask => ({
      Id: r.Id,
      Subject: r.Subject,
      ActivityDate: r.ActivityDate,
      AccountId: r.AccountId,
      AccountName: r.Account?.Name ?? null,
      AccountUrl: r.AccountId
        ? `${credentials.instance_url}/${r.AccountId}`
        : null,
      AccountWebsite: r.Account?.Website ?? null,
      AccountEmployees: typeof r.Account?.NumberOfEmployees === "number" ? r.Account.NumberOfEmployees : null,
      AccountFounded: extractYear(r.Account?.Year_Established__c),
      Priority: r.Priority,
    })
  );
}

// ── Hard delete a task ───────────────────────────────────────────────────────

export async function hardDeleteTask(taskId: string): Promise<void> {
  assertSalesforceId(taskId, "task id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const response = await sfFetch(
    `/services/data/v62.0/sobjects/Task/${taskId}`,
    {
      method: "DELETE",
    },
    credentials,
  );

  if (!response.ok && response.status !== 204) {
    const err = await sfErrorText(response);
    throw new Error(`Delete failed: ${err}`);
  }
}

// ── Mark complete and create a new task ──────────────────────────────────────

export async function completeAndReschedule(
  taskId: string,
  accountId: string,
  subject: string,
  daysFromNow: number
): Promise<void> {
  assertSalesforceId(taskId, "task id");
  assertSalesforceId(accountId, "account id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Step 1: Mark the existing task as Completed
  const completeRes = await sfFetch(
    `/services/data/v62.0/sobjects/Task/${taskId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Status: "Completed",
        ActivityDate: format(new Date(), "yyyy-MM-dd"),
        Subject_Type__c: "RCE1",
      }),
    },
    credentials,
  );

  if (!completeRes.ok) {
    const err = await sfErrorText(completeRes);
    throw new Error(`Could not mark task as completed: ${err}`);
  }

  // Step 2: Create a new open task on the same account
  const newDate = format(addDays(new Date(), daysFromNow), "yyyy-MM-dd");

  const createRes = await sfFetch(
    `/services/data/v62.0/sobjects/Task`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Subject: subject,
        Status: "Open",
        Priority: "Normal",
        ActivityDate: newDate,
        WhatId: accountId,
        OwnerId: credentials.salesforce_user_id,
        Subject_Type__c: "RCE1",
      }),
    },
    credentials,
  );

  if (!createRes.ok) {
    const err = await sfErrorText(createRes);
    throw new Error(`Could not create new task: ${err}`);
  }
}

// ── Delay a task by X days ───────────────────────────────────────────────────

export async function delayTask(
  taskId: string,
  currentDate: string,
  days: number
): Promise<string> {
  assertSalesforceId(taskId, "task id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const newDate = format(addDays(new Date(currentDate), days), "yyyy-MM-dd");

  const response = await sfFetch(
    `/services/data/v62.0/sobjects/Task/${taskId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ActivityDate: newDate }),
    },
    credentials,
  );

  if (!response.ok) {
    const err = await sfErrorText(response);
    throw new Error(`Delay failed: ${err}`);
  }

  return newDate;
}

// ── Log an action to Supabase ────────────────────────────────────────────────

export async function logAction(params: {
  taskId: string;
  accountName: string | null;
  actionType: "hard_delete" | "complete_reschedule" | "delay";
  daysUsed?: number;
  oldDate?: string;
  newDate?: string;
  success: boolean;
  errorMessage?: string;
}) {
  try {
    const supabase = getSupabaseAdmin();
    await supabase.from("task_actions_log").insert({
      task_id: params.taskId,
      account_name: params.accountName,
      action_type: params.actionType,
      days_used: params.daysUsed ?? null,
      old_date: params.oldDate ?? null,
      new_date: params.newDate ?? null,
      success: params.success,
      error_message: params.errorMessage ?? null,
    });
  } catch {
    // Logging failures should never break the main flow
    console.error("Failed to write action log");
  }
}
