/**
 * Salesforce bookkeeping for a takeover reconnect (an account a colleague
 * worked, now emailed by Seb for the first time). A normal RCE starts from an
 * open task on the Tasks page, which already completes it and opens the next
 * one. A takeover has no such task, so on send this does it here:
 *   1. account (and the emailed contact) owned by Seb,
 *   2. a completed RCE1 task dated today,
 *   3. an open RCE1 task seven days out, so it shows in his open tasks.
 * Steps 2 and 3 are skipped when the row came from an open task (the Tasks
 * page already rolled it), and step 3 when Seb already has an open task on
 * the account.
 * Never throws: the email has already gone, so problems come back as notes.
 */
import { addDays, format } from "date-fns";
import { getValidCredentials } from "./token-manager";
import { assertSalesforceId, sfErrorText, sfFetch, sfQuery } from "./sf-query";

export type AccountContact = { id: string; name: string; firstName: string | null; email: string | null; title: string | null };
export type NewContactInput = { firstName: string; lastName: string; email: string; title?: string | null };

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function listAccountContacts(accountId: string): Promise<AccountContact[]> {
  assertSalesforceId(accountId, "account id");
  const rows = await sfQuery<{ Id: string; Name: string; FirstName: string | null; Email: string | null; Title: string | null }>(
    `SELECT Id, Name, FirstName, Email, Title FROM Contact WHERE AccountId = '${accountId}' ORDER BY LastModifiedDate DESC LIMIT 50`,
  );
  return rows.map((r) => ({ id: r.Id, name: r.Name, firstName: r.FirstName, email: r.Email?.toLowerCase() ?? null, title: r.Title }));
}

/** The contact with this email on the account, or null. */
async function findContactByEmail(accountId: string, email: string): Promise<string | null> {
  const rows = await sfQuery<{ Id: string }>(
    `SELECT Id FROM Contact WHERE AccountId = '${accountId}' AND Email = '${esc(email)}' LIMIT 1`,
  );
  return rows[0]?.Id ?? null;
}

export async function runTakeoverSalesforce(params: {
  accountId: string;
  contactId: string | null;
  newContact: NewContactInput | null;
  email: string | null;
  subject: string;
  body: string;
  /**
   * The row came from an open task on the Tasks page, which already
   * completed that task and opened the next one. Logging here too doubled
   * both (FunnelCloud, Oct 2026), so only the ownership moves run.
   */
  fromOpenTask?: boolean;
}): Promise<{ notes: string[]; contactId: string | null; tasksLogged: boolean }> {
  const notes: string[] = [];
  let contactId = params.contactId;
  try {
    const credentials = await getValidCredentials();
    if (!credentials) return { notes: ["Salesforce not connected: owner and tasks not updated."], contactId, tasksLogged: false };
    const me = credentials.salesforce_user_id;
    const accountId = assertSalesforceId(params.accountId, "account id");
    const write = async (path: string, method: string, payload: object, what: string) => {
      const res = await sfFetch(`/services/data/v62.0/${path}`, { method, body: JSON.stringify(payload) }, credentials);
      if (!res.ok) {
        notes.push(`${what} failed: ${await sfErrorText(res)}`);
        return null;
      }
      return res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as { id?: string });
    };

    if (!contactId && params.email) contactId = await findContactByEmail(accountId, params.email).catch(() => null);
    if (!contactId && params.newContact) {
      const nc = params.newContact;
      const created = await write("sobjects/Contact", "POST", {
        AccountId: accountId,
        FirstName: nc.firstName,
        LastName: nc.lastName,
        Email: nc.email,
        Title: nc.title || undefined,
        OwnerId: me,
      }, "Creating the contact");
      contactId = created?.id ?? null;
    }

    await write(`sobjects/Account/${accountId}`, "PATCH", { OwnerId: me }, "Moving the account to you");
    if (contactId) await write(`sobjects/Contact/${contactId}`, "PATCH", { OwnerId: me }, "Moving the contact to you");

    if (params.fromOpenTask) return { notes, contactId, tasksLogged: false };
    // Belt and braces for any other path: an open task of Seb's already on
    // the account is his follow-up, so a second one is not opened.
    const openTasks = await sfQuery<{ Id: string }>(
      `SELECT Id FROM Task WHERE WhatId = '${accountId}' AND OwnerId = '${me}' AND IsClosed = false LIMIT 1`,
    ).catch(() => [] as Array<{ Id: string }>);

    const today = format(new Date(), "yyyy-MM-dd");
    await write("sobjects/Task", "POST", {
      Subject: params.subject,
      Type: "Email",
      Subject_Type__c: "RCE1",
      Status: "Completed",
      ActivityDate: today,
      WhatId: accountId,
      WhoId: contactId ?? undefined,
      OwnerId: me,
      Description: params.body.slice(0, 30000),
    }, "Logging the completed RCE");
    if (openTasks.length === 0) await write("sobjects/Task", "POST", {
      Subject: params.subject,
      Subject_Type__c: "RCE1",
      Status: "Open",
      Priority: "Normal",
      ActivityDate: format(addDays(new Date(), 7), "yyyy-MM-dd"),
      WhatId: accountId,
      WhoId: contactId ?? undefined,
      OwnerId: me,
    }, "Opening the 7-day follow-up task");
  } catch (error) {
    notes.push(`Salesforce update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { notes, contactId, tasksLogged: true };
}
