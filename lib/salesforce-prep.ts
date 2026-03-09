import { getValidCredentials } from "./token-manager";

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
  const fullQuery = encodeURIComponent(
    `SELECT Id, Name, Website, Description, Industry, NumberOfEmployees, ` +
      `BillingCountry, BillingState, Year_Established__c, AnnualRevenue, ` +
      `Ownership, Phone ` +
      `FROM Account WHERE Id = '${accountId}' LIMIT 1`
  );

  let response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/query/?q=${fullQuery}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
    }
  );

  // If custom fields fail, fall back to standard fields only
  if (!response.ok) {
    const fallbackQuery = encodeURIComponent(
      `SELECT Id, Name, Website, Description, Industry, NumberOfEmployees, ` +
        `BillingCountry, BillingState, AnnualRevenue, Ownership, Phone ` +
        `FROM Account WHERE Id = '${accountId}' LIMIT 1`
    );

    response = await fetch(
      `${credentials.instance_url}/services/data/v62.0/query/?q=${fallbackQuery}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) return null;
  }

  const data = await response.json();
  const r = data.records?.[0];
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
