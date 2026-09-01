import { getValidCredentials } from "./token-manager";
import { sfQuery } from "./sf-query";

// Same team filter used in the Outreach Queue (salesforce-contacts.ts)
const QUEUE_ACCOUNT_OWNERS = [
  "Sebastian Alvarez",
  "Nate Sabb",
  "Tyson Hasegawa-Foster",
];

export type CDMAccount = {
  Id: string;
  Name: string;
  Website: string | null;
  BillingCity: string | null;
  BillingState: string | null;
  BillingCountry: string | null;
  LastActivityDate: string | null;
  OwnerName: string;
  SfUrl: string;
};

// Fetch all CDM accounts owned by the team.
// Returns all accounts where Group__c = 'CDM' and owner is on the team list.
export async function fetchCDMAccounts(): Promise<CDMAccount[]> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const ownersClause = QUEUE_ACCOUNT_OWNERS.map(
    (n) => `'${n.replace(/'/g, "\\'")}'`
  ).join(",");

  const query =
    `SELECT Id, Name, Website, BillingCity, BillingState, BillingCountry, ` +
    `LastActivityDate, Owner.Name ` +
    `FROM Account ` +
    `WHERE Group__c = 'CDM' ` +
    `AND Owner.Name IN (${ownersClause}) ` +
    `ORDER BY Name ASC`;

  type AccountRecord = {
    Id: string;
    Name: string;
    Website: string | null;
    BillingCity: string | null;
    BillingState: string | null;
    BillingCountry: string | null;
    LastActivityDate: string | null;
    Owner?: { Name?: string } | null;
  };

  const all = await sfQuery<AccountRecord>(query, credentials);

  return all.map((r) => ({
    Id: r.Id,
    Name: r.Name,
    Website: r.Website,
    BillingCity: r.BillingCity,
    BillingState: r.BillingState,
    BillingCountry: r.BillingCountry,
    LastActivityDate: r.LastActivityDate,
    OwnerName: r.Owner?.Name ?? "Unknown",
    SfUrl: `${credentials.instance_url}/${r.Id}`,
  }));
}
