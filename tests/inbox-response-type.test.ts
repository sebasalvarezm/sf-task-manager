import { beforeEach, describe, expect, it, vi } from "vitest";

const account: Record<string, string | null> = { Response_Type__c: null };
const patches: Array<Record<string, unknown>> = [];
let history = { calls: 0, opps: 0 };
let readFails = false;
vi.mock("@/lib/token-manager", () => ({ getValidCredentials: async () => ({ salesforce_user_id: "005X" }) }));
vi.mock("@/lib/salesforce-calls", () => ({ upsertFollowUpTask: async () => ({}) }));
vi.mock("@/lib/sf-query", () => ({
  assertSalesforceId: (v: string) => v,
  sfErrorText: async () => "error",
  sfQuery: async (soql: string) => {
    if (soql.includes("FROM Task")) return history.calls ? [{ Id: "T" }] : [];
    if (soql.includes("FROM Opportunity")) return history.opps ? [{ Id: "O" }] : [];
    if (readFails) throw new Error("timeout");
    return [{ Response_Type__c: account.Response_Type__c }];
  },
  sfFetch: async (path: string, init: { body?: string }) => {
    if (path.endsWith("/describe")) {
      return new Response(JSON.stringify({ fields: [
        { name: "Responded__c", label: "Responded", type: "picklist", updateable: true, picklistValues: [{ value: "Yes", label: "Yes", active: true }] },
        { name: "Response_Type__c", label: "Response Type", type: "picklist", updateable: true, picklistValues: ["Positive", "Positive - Call Held", "Neutral", "Negative"].map((v) => ({ value: v, label: v, active: true })) },
      ] }), { status: 200 });
    }
    const p = JSON.parse(init.body!);
    patches.push(p);
    if (p.Response_Type__c) account.Response_Type__c = p.Response_Type__c;
    return new Response(null, { status: 204 });
  },
}));

import { markAccountResponded, responseKind, shouldOverwriteResponseType } from "@/lib/inbox-salesforce";

const values = ["Positive", "Positive - Call Held", "Neutral", "Negative"];
beforeEach(() => { account.Response_Type__c = null; patches.length = 0; history = { calls: 0, opps: 0 }; readFails = false; });

describe("response type is never downgraded from positive", () => {
  it("any positive-type value counts as positive, not just the exact one", () => {
    expect(responseKind("Positive - Call Held", values)).toBe("positive");
    expect(shouldOverwriteResponseType("Positive - Call Held", "Neutral", values)).toBe(false);
    expect(responseKind("Not interested", ["Interested", "Not interested"])).toBe("negative");
  });
  it("OptiPro: positive account, not-now reply: Responded set, type kept", async () => {
    account.Response_Type__c = "Positive";
    const out = await markAccountResponded("001OPTI", "neutral");
    expect(out.keptExisting).toBe("Positive");
    expect(patches[0]).toEqual({ Responded__c: "Yes" });
    expect(account.Response_Type__c).toBe("Positive");
  });
  it("empty type but calls already held: a not-now reply is written as Positive", async () => {
    history.calls = 1;
    const out = await markAccountResponded("001OPTI", "neutral");
    expect(out.responseTypeValue).toBe("Positive");
  });
  it("no history, empty type: neutral as before", async () => {
    expect((await markAccountResponded("001NEW", "neutral")).responseTypeValue).toBe("Neutral");
  });
  it("cannot read the current value: leaves the type alone", async () => {
    readFails = true;
    account.Response_Type__c = "Positive";
    const out = await markAccountResponded("001OPTI", "neutral");
    expect(out.responseTypeValue).toBeNull();
    expect(patches[0]).toEqual({ Responded__c: "Yes" });
  });
  it("a do-not-contact still lands on a positive account", async () => {
    account.Response_Type__c = "Positive";
    expect((await markAccountResponded("001OPTI", "negative")).responseTypeValue).toBe("Negative");
  });
});
