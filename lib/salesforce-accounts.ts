import { getValidCredentials } from "./token-manager";

// Fields sent to Salesforce when creating an Account
export type AccountCreatePayload = {
  Name: string;
  Website: string;
  Year_Established__c?: string;
  NumberOfEmployees?: number;
  Industry?: string;
  BillingCountry?: string;
  BillingState?: string;
  Group__c?: string;
  Stage__c?: string;
  Responded__c?: string;
};

export type AccountCreateResult = {
  id: string;
  url: string; // direct link to the account in Salesforce
};

export async function createAccount(
  payload: AccountCreatePayload
): Promise<AccountCreateResult> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Account`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create account: ${err}`);
  }

  const result = await response.json();
  return {
    id: result.id,
    url: `${credentials.instance_url}/${result.id}`,
  };
}

// Fields that may be patched onto an EXISTING account. All optional, and
// deliberately not `AccountCreatePayload` — that type requires Name + Website.
// Today's only caller is the outreach-quality fix-it flow, which backfills the
// three fields the BS score reads.
export type AccountFieldUpdate = {
  Year_Established__c?: string; // text field in Salesforce, not a number
  NumberOfEmployees?: number;
  BillingCountry?: string;
};

/**
 * Patches fields onto an existing Account.
 *
 * Note the missing `response.json()`: a successful record PATCH returns
 * 204 No Content, so parsing the body — as createAccount does — would throw.
 * Same shape as delayTask in lib/salesforce.ts.
 */
export async function updateAccount(
  accountId: string,
  fields: AccountFieldUpdate
): Promise<void> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");

  const response = await fetch(
    `${credentials.instance_url}/services/data/v62.0/sobjects/Account/${accountId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fields),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to update account: ${err}`);
  }
}
