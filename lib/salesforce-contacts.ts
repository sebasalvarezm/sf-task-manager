import { getValidCredentials } from "./token-manager";

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
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Build the Owner.Name IN (...) clause safely
  const ownersClause = QUEUE_ACCOUNT_OWNERS
    .map((n) => `'${n.replace(/'/g, "\\'")}'`)
    .join(",");

  // Fetch all E1-E5 tasks with account + owner info in one query
  const query = encodeURIComponent(
    `SELECT Id, Subject, Subject_Type__c, ActivityDate, CompletedDateTime, ` +
      `AccountId, Account.Name, Account.Website, Account.Responded__c, ` +
      `Account.LastActivityDate, Account.Owner.Name, ` +
      `WhoId, Who.Name, Who.Email, Status, Type ` +
      `FROM Task ` +
      `WHERE Subject_Type__c IN ('E1','E2','E3','E4','E5') ` +
      `AND AccountId != null ` +
      `AND Account.Owner.Name IN (${ownersClause}) ` +
      `ORDER BY AccountId, ActivityDate ASC`
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
    throw new Error(`SF fetchAccountsWithEHistory failed: ${err}`);
  }

  // Paginate through all records
  type TaskRecord = {
    Id: string;
    Subject: string;
    Subject_Type__c: string;
    ActivityDate: string | null;
    CompletedDateTime: string | null;
    AccountId: string;
    Account?: {
      Name?: string;
      Website?: string | null;
      Responded__c?: string | null;
      LastActivityDate?: string | null;
    } | null;
    WhoId: string | null;
    Who?: { Name?: string; Email?: string } | null;
    Status: string;
    Type: string | null;
  };

  let body = (await response.json()) as {
    records?: TaskRecord[];
    nextRecordsUrl?: string;
    done?: boolean;
  };
  const allTasks: TaskRecord[] = [...(body.records ?? [])];

  while (body.nextRecordsUrl && !body.done) {
    const nextRes = await fetch(
      `${credentials.instance_url}${body.nextRecordsUrl}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!nextRes.ok) break;
    body = await nextRes.json();
    allTasks.push(...(body.records ?? []));
  }

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
        },
        tasks: [t],
      });
    }
  }

  // Keep only accounts with at least one E5 completed in 2026
  const result: SfAccountWithETasks[] = [];
  for (const { account, tasks } of byAccount.values()) {
    const hasE5In2026 = tasks.some((t) => {
      if (t.Subject_Type__c !== "E5" || t.Status !== "Completed") return false;
      const dateStr = t.CompletedDateTime ?? t.ActivityDate;
      if (!dateStr) return false;
      const year = new Date(dateStr).getUTCFullYear();
      return year === 2026;
    });
    if (!hasE5In2026) continue;

    result.push({
      Id: account.Id,
      Name: account.Name ?? "(Unnamed)",
      Website: account.Website ?? null,
      Responded__c: account.Responded__c ?? null,
      LastActivityDate: account.LastActivityDate ?? null,
      Tasks: tasks.map((t) => ({
        Id: t.Id,
        Subject: t.Subject,
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
// Much faster than calling fetchContactsForAccount() in a loop.

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

    const query = encodeURIComponent(
      `SELECT Id, FirstName, LastName, Name, Title, Email, AccountId ` +
        `FROM Contact WHERE AccountId IN (${idsList})`
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
      throw new Error(`SF fetchContactsForAccounts failed: ${err}`);
    }

    const data = (await response.json()) as {
      records?: Array<{
        Id: string;
        FirstName: string | null;
        LastName: string | null;
        Name: string;
        Title: string | null;
        Email: string | null;
        AccountId: string | null;
      }>;
    };

    for (const r of data.records ?? []) {
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

export async function fetchContactsForAccount(
  accountId: string
): Promise<SfContact[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const query = encodeURIComponent(
    `SELECT Id, FirstName, LastName, Name, Title, Email, AccountId ` +
      `FROM Contact WHERE AccountId = '${accountId}'`
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
    throw new Error(`SF fetchContactsForAccount failed: ${err}`);
  }

  const data = (await response.json()) as {
    records?: Array<{
      Id: string;
      FirstName: string | null;
      LastName: string | null;
      Name: string;
      Title: string | null;
      Email: string | null;
      AccountId: string | null;
    }>;
  };

  return (data.records ?? []).map((r) => ({
    Id: r.Id,
    FirstName: r.FirstName,
    LastName: r.LastName,
    Name: r.Name,
    Title: r.Title,
    Email: r.Email,
    AccountId: r.AccountId,
  }));
}

// ── Upsert a contact on an account ──────────────────────────────────────────
// Finds existing contact by email on the account, otherwise creates a new one.
// Returns the Salesforce Contact Id.

export async function upsertContact(params: {
  accountId: string;
  firstName: string;
  lastName: string;
  email: string;
  title?: string;
}): Promise<{ id: string; created: boolean }> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // 1. Look for an existing contact on the account with this email
  const safeEmail = params.email.replace(/'/g, "\\'");
  const safeAccountId = params.accountId.replace(/'/g, "\\'");
  const lookupQuery = encodeURIComponent(
    `SELECT Id FROM Contact ` +
      `WHERE AccountId = '${safeAccountId}' AND Email = '${safeEmail}' LIMIT 1`
  );

  const lookupRes = await fetch(
    `${credentials.instance_url}/services/data/v62.0/query/?q=${lookupQuery}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (lookupRes.ok) {
    const body = (await lookupRes.json()) as {
      records?: Array<{ Id: string }>;
    };
    const existing = body.records?.[0];
    if (existing) return { id: existing.Id, created: false };
  }

  // 2. Create a new contact
  const createRes = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Contact`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        AccountId: params.accountId,
        FirstName: params.firstName,
        LastName: params.lastName,
        Email: params.email,
        Title: params.title ?? null,
      }),
    }
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`SF upsertContact create failed: ${err}`);
  }

  const body = (await createRes.json()) as { id: string };
  return { id: body.id, created: true };
}
