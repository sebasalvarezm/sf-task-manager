import { getValidCredentials } from "./token-manager";
import { sfQuery } from "./sf-query";

// ── Types ────────────────────────────────────────────────────────────────────

export type SfContact = {
  Id: string;
  FirstName: string | null;
  LastName: string | null;
  Name: string;
  Title: string | null;
  Email: string | null;
  AccountId: string | null;
};

export type SfETask = {
  Id: string;
  Subject: string;
  Description: string | null;
  SubjectType: string; // E1..E5
  ActivityDate: string | null;
  CompletedDateTime: string | null;
  WhoId: string | null;
  WhoName: string | null;
  WhoEmail: string | null;
  Status: string;
  Type: string | null;
};

export type SfAccountWithETasks = {
  Id: string;
  Name: string;
  Website: string | null;
  Responded__c: string | null;
  LastActivityDate: string | null;
  Employees: number | null;
  Tasks: SfETask[];
};

// ── Fetch accounts with E1-E5 task history ──────────────────────────────────
// Returns every account where at least one E5 task has been completed in 2026,
// AND the account is owned by Sebastian Alvarez, Nate Sabb, or Tyson Hasegawa-Foster.
// Salesforce doesn't support semi-joins on Task, so we do this in two steps:
//   1. Query all E1-E5 tasks directly (with owner filter) and group by AccountId in JS
//   2. Keep only accounts with at least one E5 completed in 2026

const QUEUE_ACCOUNT_OWNERS = [
  "Sebastian Alvarez",
  "Nate Sabb",
  "Tyson Hasegawa-Foster",
];

export async function fetchAccountsWithEHistory(): Promise<
  SfAccountWithETasks[]
> {
  // Build the Owner.Name IN (...) clause safely
  const ownersClause = QUEUE_ACCOUNT_OWNERS
    .map((n) => `'${n.replace(/'/g, "\\'")}'`)
    .join(",");

  // Fetch all E1-E5 tasks with account + owner info in one query
  const query =
    `SELECT Id, Subject, Description, Subject_Type__c, ActivityDate, CompletedDateTime, ` +
    `AccountId, Account.Name, Account.Website, Account.Responded__c, ` +
    `Account.LastActivityDate, Account.NumberOfEmployees, Account.Owner.Name, ` +
    `WhoId, Who.Name, Who.Email, Status, Type ` +
    `FROM Task ` +
    `WHERE Subject_Type__c IN ('E1','E2','E3','E4','E5') ` +
    `AND AccountId != null ` +
    `AND Account.Owner.Name IN (${ownersClause}) ` +
    `ORDER BY AccountId, ActivityDate ASC`;

  type TaskRecord = {
    Id: string;
    Subject: string;
    Description: string | null;
    Subject_Type__c: string;
    ActivityDate: string | null;
    CompletedDateTime: string | null;
    AccountId: string;
    Account?: {
      Name?: string;
      Website?: string | null;
      Responded__c?: string | null;
      LastActivityDate?: string | null;
      NumberOfEmployees?: number | null;
    } | null;
    WhoId: string | null;
    Who?: { Name?: string; Email?: string } | null;
    Status: string;
    Type: string | null;
  };

  const allTasks = await sfQuery<TaskRecord>(query);

  // Group tasks by AccountId
  const byAccount = new Map<string, { account: TaskRecord["Account"] & { Id: string }; tasks: TaskRecord[] }>();

  for (const t of allTasks) {
    if (!t.AccountId) continue;
    const existing = byAccount.get(t.AccountId);
    if (existing) {
      existing.tasks.push(t);
    } else {
      byAccount.set(t.AccountId, {
        account: {
          Id: t.AccountId,
          Name: t.Account?.Name ?? "(Unnamed)",
          Website: t.Account?.Website ?? null,
          Responded__c: t.Account?.Responded__c ?? null,
          LastActivityDate: t.Account?.LastActivityDate ?? null,
          NumberOfEmployees: t.Account?.NumberOfEmployees ?? null,
        },
        tasks: [t],
      });
    }
  }

  // Keep only accounts whose MOST RECENT completed E5 was ACTUALLY SENT
  // on or after 2026-01-15 (the sourcing-strategy switch date), based on
  // CompletedDateTime only.
  //
  // CompletedDateTime is set by SF automatically when Status flips to
  // Completed and reliably reflects the actual send timestamp for
  // Outreach-synced emails. ActivityDate, by contrast, is a plain date
  // field that can be set to future/scheduled dates (e.g., when Outreach
  // schedules an email ahead of time) or edited manually. Falling back
  // to ActivityDate was incorrectly admitting accounts whose real emails
  // went out earlier but had some later-dated placeholder/scheduled task.
  const result: SfAccountWithETasks[] = [];
  for (const { account, tasks } of byAccount.values()) {
    const e5Dates = tasks
      .filter((t) => t.Subject_Type__c === "E5" && t.Status === "Completed")
      .map((t) => t.CompletedDateTime)
      .filter((d): d is string => !!d)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

    const mostRecentE5 = e5Dates[0];
    if (!mostRecentE5) continue;

    // Sourcing strategy switched on 2026-01-15. Accounts whose most-recent
    // E5 was sent before that date used the prior strategy and must not
    // resurface (this also rejects all 2025-and-earlier sends).
    const CUTOFF_MS = Date.UTC(2026, 0, 15); // 2026-01-15 00:00:00 UTC, inclusive
    if (new Date(mostRecentE5).getTime() < CUTOFF_MS) continue;

    result.push({
      Id: account.Id,
      Name: account.Name ?? "(Unnamed)",
      Website: account.Website ?? null,
      Responded__c: account.Responded__c ?? null,
      LastActivityDate: account.LastActivityDate ?? null,
      Employees: account.NumberOfEmployees ?? null,
      Tasks: tasks.map((t) => ({
        Id: t.Id,
        Subject: t.Subject,
        Description: t.Description,
        SubjectType: t.Subject_Type__c,
        ActivityDate: t.ActivityDate,
        CompletedDateTime: t.CompletedDateTime,
        WhoId: t.WhoId,
        WhoName: t.Who?.Name ?? null,
        WhoEmail: t.Who?.Email ?? null,
        Status: t.Status,
        Type: t.Type,
      })),
    });
  }

  return result;
}

// ── Fetch contacts for many accounts at once ─────────────────────────────────

export async function fetchContactsForAccounts(
  accountIds: string[]
): Promise<Map<string, SfContact[]>> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const byAccount = new Map<string, SfContact[]>();
  if (accountIds.length === 0) return byAccount;

  // Chunk to avoid hitting SOQL length limits (~20k chars)
  const CHUNK_SIZE = 200;
  for (let i = 0; i < accountIds.length; i += CHUNK_SIZE) {
    const chunk = accountIds.slice(i, i + CHUNK_SIZE);
    const idsList = chunk.map((id) => `'${id}'`).join(",");

    const query =
      `SELECT Id, FirstName, LastName, Name, Title, Email, AccountId ` +
      `FROM Contact WHERE AccountId IN (${idsList})`;

    const records = await sfQuery<{
      Id: string;
      FirstName: string | null;
      LastName: string | null;
      Name: string;
      Title: string | null;
      Email: string | null;
      AccountId: string | null;
    }>(query, credentials);

    for (const r of records) {
      if (!r.AccountId) continue;
      const list = byAccount.get(r.AccountId) ?? [];
      list.push({
        Id: r.Id,
        FirstName: r.FirstName,
        LastName: r.LastName,
        Name: r.Name,
        Title: r.Title,
        Email: r.Email,
        AccountId: r.AccountId,
      });
      byAccount.set(r.AccountId, list);
    }
  }

  return byAccount;
}

// ── Fetch all contacts on a single account ──────────────────────────────────

