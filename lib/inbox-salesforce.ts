import { getValidCredentials } from "./token-manager";
import { sfFetch, sfErrorText, assertSalesforceId } from "./sf-query";
import { upsertFollowUpTask, type FollowUpOutcome } from "./salesforce-calls";
import type { Sentiment } from "./inbox-classify";

/**
 * Inbox: the only Salesforce writes the module makes.
 *   1. Account.Responded = Yes, plus the response-type picklist when the org has one.
 *   2. Create or move the account's open RCE task.
 * Field names and picklist values are read from Account/describe once per
 * process, so nothing is hard-coded to one org's setup.
 */

type DescribeField = {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  picklistValues?: Array<{ value: string; label: string; active: boolean }>;
};

export type ResponseFields = {
  responded: { name: string; yesValue: string | boolean } | null;
  responseType: { name: string; label: string; values: string[] } | null;
};

let cached: ResponseFields | null = null;

export async function describeResponseFields(force = false): Promise<ResponseFields> {
  if (cached && !force) return cached;
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const response = await sfFetch(`/services/data/v62.0/sobjects/Account/describe`, {}, credentials);
  if (!response.ok) throw new Error(`Account describe failed: ${await sfErrorText(response)}`);
  const data = (await response.json()) as { fields?: DescribeField[] };
  const fields = (data.fields ?? []).filter((f) => f.updateable);

  let responded: ResponseFields["responded"] = null;
  const respondedField = fields.find((f) => f.name === "Responded__c") ?? fields.find((f) => /^responded/i.test(f.name));
  if (respondedField) {
    if (respondedField.type === "boolean") responded = { name: respondedField.name, yesValue: true };
    else {
      const yes = (respondedField.picklistValues ?? []).find((v) => v.active && /^(yes|y|true)$/i.test(v.value));
      responded = { name: respondedField.name, yesValue: yes?.value ?? "Yes" };
    }
  }

  let responseType: ResponseFields["responseType"] = null;
  const typeField =
    fields.find((f) => f.type === "picklist" && /respon(se|ded).*type|type.*respon/i.test(f.name + " " + f.label) && f.name !== respondedField?.name) ??
    fields.find((f) => f.type === "picklist" && /respon/i.test(f.name + " " + f.label) && f.name !== respondedField?.name);
  if (typeField) {
    responseType = {
      name: typeField.name,
      label: typeField.label,
      values: (typeField.picklistValues ?? []).filter((v) => v.active).map((v) => v.value),
    };
  }
  cached = { responded, responseType };
  return cached;
}

/** Pick the org's picklist value that means this sentiment, or null when none fits. */
export function pickResponseTypeValue(values: string[], sentiment: Sentiment): string | null {
  const lower = values.map((v) => [v, v.toLowerCase()] as const);
  const find = (patterns: RegExp[]) => {
    for (const re of patterns) {
      const hit = lower.find(([, l]) => re.test(l));
      if (hit) return hit[0];
    }
    return null;
  };
  if (sentiment === "positive") return find([/^positive/, /interested/, /call/, /meeting/, /^yes/, /warm/]);
  if (sentiment === "negative") return find([/^negative/, /do not|don't|never|stop|remove|unsubscribe/, /not interested/, /^no\b/, /cold/]);
  if (sentiment === "neutral") return find([/^neutral/, /not now|later|defer|future|timing|maybe/, /not interested/, /^no\b/]);
  return null;
}

export type RespondedOutcome = {
  respondedField: string | null;
  responseTypeField: string | null;
  responseTypeValue: string | null;
};

export async function markAccountResponded(accountId: string, sentiment: Sentiment): Promise<RespondedOutcome> {
  assertSalesforceId(accountId, "account id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const fields = await describeResponseFields();
  const patch: Record<string, unknown> = {};
  const outcome: RespondedOutcome = { respondedField: null, responseTypeField: null, responseTypeValue: null };
  if (fields.responded) {
    patch[fields.responded.name] = fields.responded.yesValue;
    outcome.respondedField = fields.responded.name;
  }
  if (fields.responseType) {
    const value = pickResponseTypeValue(fields.responseType.values, sentiment);
    if (value) {
      patch[fields.responseType.name] = value;
      outcome.responseTypeField = fields.responseType.name;
      outcome.responseTypeValue = value;
    }
  }
  if (Object.keys(patch).length === 0) return outcome;
  const response = await sfFetch(
    `/services/data/v62.0/sobjects/Account/${accountId}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
    credentials,
  );
  if (!response.ok && response.status !== 204) {
    throw new Error(`Could not update the account: ${await sfErrorText(response)}`);
  }
  return outcome;
}

/** Create or move the account's RCE task to `days` after `fromDate`. */
export async function scheduleRceTask(accountId: string, fromDate: string, days: number): Promise<FollowUpOutcome> {
  return upsertFollowUpTask({
    accountId,
    subject: "RCE",
    subjectType: "RCE1", // same picklist value the Call Logger uses for an open reconnect
    meetingDate: fromDate.slice(0, 10),
    daysFromMeeting: days,
  });
}
