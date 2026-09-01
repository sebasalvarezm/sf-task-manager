import { getValidCredentials } from "./token-manager";
import { sfQuery } from "./sf-query";

// Rich Account data for Call Prep one-pager generation
export type AccountDetails = {
  id: string;
  name: string;
  website: string | null;
  description: string | null;
  industry: string | null;
  numberOfEmployees: number | null;
  billingCountry: string | null;
  billingState: string | null;
  yearEstablished: string | null;
  annualRevenue: number | null;
  ownership: string | null;
  phone: string | null;
  sfUrl: string;
};

export async function fetchAccountDetails(
  accountId: string
): Promise<AccountDetails | null> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Try with custom fields first
  const fullQuery =
    `SELECT Id, Name, Website, Description, Industry, NumberOfEmployees, ` +
    `BillingCountry, BillingState, Year_Established__c, AnnualRevenue, ` +
    `Ownership, Phone ` +
    `FROM Account WHERE Id = '${accountId}' LIMIT 1`;

  type AccountRecord = {
    Id: string;
    Name: string;
    Website?: string | null;
    Description?: string | null;
    Industry?: string | null;
    NumberOfEmployees?: number | null;
    BillingCountry?: string | null;
    BillingState?: string | null;
    Year_Established__c?: string | null;
    AnnualRevenue?: number | null;
    Ownership?: string | null;
    Phone?: string | null;
  };

  let records: AccountRecord[];
  try {
    records = await sfQuery<AccountRecord>(fullQuery, credentials);
  } catch {
    // If custom fields fail, fall back to standard fields only
    const fallbackQuery =
      `SELECT Id, Name, Website, Description, Industry, NumberOfEmployees, ` +
      `BillingCountry, BillingState, AnnualRevenue, Ownership, Phone ` +
      `FROM Account WHERE Id = '${accountId}' LIMIT 1`;

    try {
      records = await sfQuery<AccountRecord>(fallbackQuery, credentials);
    } catch {
      return null;
    }
  }

  const r = records[0];
  if (!r) return null;

  return {
    id: r.Id,
    name: r.Name,
    website: r.Website ?? null,
    description: r.Description ?? null,
    industry: r.Industry ?? null,
    numberOfEmployees: r.NumberOfEmployees ?? null,
    billingCountry: r.BillingCountry ?? null,
    billingState: r.BillingState ?? null,
    yearEstablished: r.Year_Established__c ?? null,
    annualRevenue: r.AnnualRevenue ?? null,
    ownership: r.Ownership ?? null,
    phone: r.Phone ?? null,
    sfUrl: `${credentials.instance_url}/${r.Id}`,
  };
}

export async function fetchRecentAccountActivity(accountId: string): Promise<string[]> {
  const soql =
    `SELECT Subject, Description, ActivityDate, CreatedDate, Status ` +
    `FROM Task WHERE WhatId = '${accountId.replace(/'/g, "\\'")}' ` +
    `ORDER BY CreatedDate DESC LIMIT 12`;
  let records: Array<{ Subject?: string; Description?: string; ActivityDate?: string; CreatedDate?: string; Status?: string }>;
  try {
    records = await sfQuery<{ Subject?: string; Description?: string; ActivityDate?: string; CreatedDate?: string; Status?: string }>(soql);
  } catch (err) {
    // Preserve the NOT_CONNECTED signal; any other query failure keeps the old
    // "fail soft" behavior of returning no activity lines.
    if (err instanceof Error && err.message === "NOT_CONNECTED") throw err;
    return [];
  }
  return records.map((row) => {
    const date = row.ActivityDate ?? row.CreatedDate?.slice(0, 10) ?? "unknown date";
    const description = row.Description?.trim() ? ` — ${row.Description.trim().slice(0, 500)}` : "";
    return `${date}: ${row.Subject ?? "Activity"} (${row.Status ?? "unknown"})${description}`;
  });
}
