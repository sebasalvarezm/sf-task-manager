import { getValidCredentials } from "./token-manager";
import { getSupabaseAdmin } from "./supabase";
import { addDays, format } from "date-fns";

export type SalesforceTask = {
  Id: string;
  Subject: string;
  ActivityDate: string; // ISO date string: "2026-03-05"
  AccountId: string | null;
  AccountName: string | null;
  AccountUrl: string | null;
  AccountWebsite: string | null; // Company's own website (e.g. https://acme.com)
  Priority: string;
};

// ── Fetch open tasks ─────────────────────────────────────────────────────────

export async function fetchOpenTasks(): Promise<SalesforceTask[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const userId = credentials.salesforce_user_id;
  if (!userId) throw new Error("NOT_CONNECTED");

  const query = encodeURIComponent(
    `SELECT Id, Subject, ActivityDate, AccountId, Account.Name, Account.Website, Priority ` +
      `FROM Task ` +
      `WHERE Status = 'Open' ` +
      `AND OwnerId = '${userId}' ` +
      `ORDER BY ActivityDate ASC NULLS FIRST`
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

  return (data.records ?? []).map(
    (r: {
      Id: string;
      Subject: string;
      ActivityDate: string;
      AccountId: string | null;
      Account?: { Name: string; Website?: string | null } | null;
      Priority: string;
    }): SalesforceTask => ({
      Id: r.Id,
      Subject: r.Subject,
      ActivityDate: r.ActivityDate,
      AccountId: r.AccountId,
      AccountName: r.Account?.Name ?? null,
      AccountUrl: r.AccountId
        ? `${credentials.instance_url}/${r.AccountId}`
        : null,
      AccountWebsite: r.Account?.Website ?? null,
      Priority: r.Priority,
    })
  );
}

// ── Hard delete a task ───────────────────────────────────────────────────────

export async function hardDeleteTask(taskId: string): Promise<void> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Task/${taskId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${credentials.access_token}` },
    }
  );

  if (!response.ok && response.status !== 204) {
    const err = await response.text();
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
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Step 1: Mark the existing task as Completed
  const completeRes = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Task/${taskId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ Status: "Completed" }),
    }
  );

  if (!completeRes.ok) {
    const err = await completeRes.text();
    throw new Error(`Could not mark task as completed: ${err}`);
  }

  // Step 2: Create a new open task on the same account
  const newDate = format(addDays(new Date(), daysFromNow), "yyyy-MM-dd");

  const createRes = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Task`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Subject: subject,
        Status: "Not Started",
        Priority: "Normal",
        ActivityDate: newDate,
        WhatId: accountId,
        OwnerId: credentials.salesforce_user_id,
      }),
    }
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Could not create new task: ${err}`);
  }
}

// ── Delay a task by X days ───────────────────────────────────────────────────

export async function delayTask(
  taskId: string,
  currentDate: string,
  days: number
): Promise<string> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const newDate = format(addDays(new Date(currentDate), days), "yyyy-MM-dd");

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Task/${taskId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ActivityDate: newDate }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
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
