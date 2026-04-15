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
// Returns every account where at least one E5 task has been completed.
// Includes the full E1-E5 task history so the classification engine can
// group by contact and determine which accounts are due for follow-up.

export async function fetchAccountsWithEHistory(): Promise<
  SfAccountWithETasks[]
> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  // Inner subquery: all E-tasks on the account
  // Outer filter: only accounts that have at least one completed E5
  const query = encodeURIComponent(
    `SELECT Id, Name, Website, Responded__c, LastActivityDate, ` +
      `(SELECT Id, Subject, Subject_Type__c, ActivityDate, CompletedDateTime, ` +
      `WhoId, Who.Name, Who.Email, Status, Type ` +
      `FROM Tasks ` +
      `WHERE Subject_Type__c IN ('E1','E2','E3','E4','E5') ` +
      `ORDER BY ActivityDate ASC) ` +
      `FROM Account ` +
      `WHERE Id IN ( ` +
      `SELECT AccountId FROM Task ` +
      `WHERE Subject_Type__c = 'E5' AND Status = 'Completed' ` +
      `)`
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

  const data = (await response.json()) as {
    records?: Array<{
      Id: string;
      Name: string;
      Website: string | null;
      Responded__c: string | null;
      LastActivityDate: string | null;
      Tasks?: {
        records?: Array<{
          Id: string;
          Subject: string;
          Subject_Type__c: string;
          ActivityDate: string | null;
          CompletedDateTime: string | null;
          WhoId: string | null;
          Who?: { Name?: string; Email?: string } | null;
          Status: string;
          Type: string | null;
        }>;
      } | null;
    }>;
  };

  return (data.records ?? []).map((r) => ({
    Id: r.Id,
    Name: r.Name,
    Website: r.Website,
    Responded__c: r.Responded__c,
    LastActivityDate: r.LastActivityDate,
    Tasks: (r.Tasks?.records ?? []).map((t) => ({
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
  }));
}

// ── Fetch all contacts on an account ────────────────────────────────────────

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
