import { getValidCredentials } from "./token-manager";
import { sfFetch, sfErrorText, assertSalesforceId, sfQuery } from "./sf-query";
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
  /** The value already on the account that was deliberately left in place. */
  keptExisting: string | null;
};

/** Which kind of response a picklist value means, whatever the org calls it ("Positive - call held" is positive). */
export function responseKind(value: string | null | undefined, values: string[]): Sentiment | null {
  if (!value || !value.trim()) return null;
  const v = value.trim();
  for (const s of ["negative", "positive", "neutral"] as const) if (pickResponseTypeValue(values, s) === v) return s;
  const l = v.toLowerCase();
  if (/^negative|do not|don't|never|stop|remove|unsubscribe|not interested|cold/.test(l)) return "negative";
  if (/^positive|interested|call|meeting|^yes|warm/.test(l)) return "positive";
  if (/^neutral|not now|later|defer|future|timing|maybe/.test(l)) return "neutral";
  return null;
}

/**
 * Positive is sticky: an account that once agreed to talk and is now "too
 * busy, try Q1" is still a positive relationship, and the stats should say
 * so. Negative always wins (do-not-contact must land). Neutral only fills an
 * empty field or replaces another non-positive value. Compared by kind, not
 * exact text, so any positive-type value counts as positive.
 */
export function shouldOverwriteResponseType(current: string | null, next: string, values: string[]): boolean {
  if (!current || !current.trim()) return true;
  if (current === next) return false;
  const now = responseKind(current, values);
  const then = responseKind(next, values);
  if (then === "negative") return true;
  if (now === "positive") return false;
  if (now === "negative") return false; // only the user should walk a do-not-contact back
  return true;
}

/**
 * Calls or meetings already held (a completed C1, RCC or F2F task) or any
 * opportunity on the account: the relationship is positive, so a "not now"
 * reply does not make it neutral (OptiPro, Nov 2026).
 */
export async function hasPositiveHistory(accountId: string): Promise<boolean> {
  assertSalesforceId(accountId, "account id");
  const [calls, opps] = await Promise.all([
    sfQuery<{ Id: string }>(`SELECT Id FROM Task WHERE AccountId = '${accountId}' AND Status = 'Completed' AND Subject_Type__c IN ('C1','RCC','F2F') LIMIT 1`),
    sfQuery<{ Id: string }>(`SELECT Id FROM Opportunity WHERE AccountId = '${accountId}' LIMIT 1`),
  ]);
  return calls.length > 0 || opps.length > 0;
}

export async function markAccountResponded(accountId: string, sentiment: Sentiment): Promise<RespondedOutcome> {
  assertSalesforceId(accountId, "account id");
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const fields = await describeResponseFields();
  const patch: Record<string, unknown> = {};
  const outcome: RespondedOutcome = { respondedField: null, responseTypeField: null, responseTypeValue: null, keptExisting: null };
  if (fields.responded) {
    patch[fields.responded.name] = fields.responded.yesValue;
    outcome.respondedField = fields.responded.name;
  }
  if (fields.responseType) {
    // A "not now" from an account where calls were already held stays positive.
    let kind: Sentiment = sentiment;
    if (sentiment === "neutral" && (await hasPositiveHistory(accountId).catch(() => false))) kind = "positive";
    const value = pickResponseTypeValue(fields.responseType.values, kind);
    if (value) {
      let current: string | null = null;
      let readOk = true;
      try {
        const rows = await sfQuery<Record<string, unknown>>(
          `SELECT ${fields.responseType.name} FROM Account WHERE Id = '${accountId}' LIMIT 1`,
          credentials,
        );
        const raw = rows[0]?.[fields.responseType.name];
        current = typeof raw === "string" ? raw : null;
      } catch {
        readOk = false;
      }
      // If the current value could not be read, leave it alone rather than risk overwriting a positive.
      if (readOk && shouldOverwriteResponseType(current, value, fields.responseType.values)) {
        patch[fields.responseType.name] = value;
        outcome.responseTypeField = fields.responseType.name;
        outcome.responseTypeValue = value;
      } else {
        outcome.keptExisting = current;
      }
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
