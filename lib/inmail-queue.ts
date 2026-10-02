import { getValidCredentials } from "./token-manager";
import { sfQuery } from "./sf-query";
import { getSupabaseAdmin } from "./supabase";
import { getAnthropicClient } from "./anthropic";
import { cleanE1Body } from "./outreach-queue";
import {
  INMAIL_SYSTEM_PROMPT,
  firstNameOf,
  followUpTemplate,
  googleLinkedInUrl,
  inmailSubject,
  inmailUserPrompt,
  navigatorSearchUrl,
  normalizeInMail,
  parseInMailJson,
  validateInitialInMail,
} from "./inmail-generate";

/**
 * InMail Queue: contacts whose E1-E5 email sequence finished (E5 completed in
 * the window) with no reply, so the next touch is a LinkedIn InMail built from
 * the E1 that was actually sent (the Salesforce copy, with Seb's edits).
 */

export type InMailStatus =
  | "pending"
  | "generated"
  | "needs_review"
  | "sent"
  | "followup_sent"
  | "dismissed";

export type InMailQueueRow = {
  who_id: string;
  account_id: string | null;
  account_name: string | null;
  contact_name: string | null;
  first_name: string | null;
  contact_email: string | null;
  e5_task_id: string | null;
  e5_sent_at: string | null;
  e1_task_id: string | null;
  e1_body: string | null;
  linkedin_url: string | null;
  navigator_url: string | null;
  status: InMailStatus;
  subject: string | null;
  initial_message: string | null;
  followup_message: string | null;
  flags: string[];
  sent_at: string | null;
  followup_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRecord = {
  Id: string;
  Subject: string;
  Description: string | null;
  Subject_Type__c: string;
  ActivityDate: string | null;
  CompletedDateTime: string | null;
  Status: string;
  WhoId: string | null;
  Who?: { Name?: string; Email?: string } | null;
  AccountId: string | null;
  Account?: {
    Name?: string;
    Responded__c?: string | boolean | null;
    LastActivityDate?: string | null;
  } | null;
};

function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function dayOf(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/** A Contact field that looks like it holds a LinkedIn URL, if the org has one. */
let cachedLinkedInField: string | null | undefined;
async function linkedInContactField(): Promise<string | null> {
  if (cachedLinkedInField !== undefined) return cachedLinkedInField;
  cachedLinkedInField = null;
  try {
    const credentials = await getValidCredentials();
    if (!credentials) return null;
    const response = await fetch(
      `${credentials.instance_url}/services/data/v62.0/sobjects/Contact/describe`,
      { headers: { Authorization: `Bearer ${credentials.access_token}` } },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { fields?: Array<{ name: string; type: string }> };
    const field = (data.fields ?? []).find(
      (f) => /linkedin/i.test(f.name) && (f.type === "url" || f.type === "string"),
    );
    cachedLinkedInField = field?.name ?? null;
  } catch {
    cachedLinkedInField = null;
  }
  return cachedLinkedInField;
}

export type RefreshSummary = { scanned: number; added: number; skippedReplied: number; skippedActivity: number };

/**
 * Find E5s completed in the last `days` days whose contact has not replied,
 * attach the E1 body, and add anything new to the queue. Existing rows are
 * never overwritten (their drafts and status belong to Seb).
 */
export async function refreshInMailQueue(days = 7): Promise<RefreshSummary> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const supabase = getSupabaseAdmin();

  const since = new Date();
  since.setDate(since.getDate() - Math.max(1, Math.min(90, days)));
  const sinceIso = since.toISOString();

  const e5s = await sfQuery<TaskRecord>(
    `SELECT Id, Subject, Description, Subject_Type__c, ActivityDate, CompletedDateTime, Status, ` +
      `WhoId, Who.Name, Who.Email, AccountId, Account.Name, Account.Responded__c, Account.LastActivityDate ` +
      `FROM Task WHERE Subject_Type__c = 'E5' AND Status = 'Completed' AND WhoId != null ` +
      `AND (CompletedDateTime >= ${sinceIso} OR (CompletedDateTime = null AND ActivityDate >= ${sinceIso.slice(0, 10)})) ` +
      `ORDER BY CompletedDateTime DESC NULLS LAST LIMIT 400`,
    credentials,
  );

  // Latest E5 per contact.
  const byWho = new Map<string, TaskRecord>();
  for (const task of e5s) {
    if (!task.WhoId) continue;
    const existing = byWho.get(task.WhoId);
    const date = task.CompletedDateTime ?? task.ActivityDate ?? "";
    const existingDate = existing?.CompletedDateTime ?? existing?.ActivityDate ?? "";
    if (!existing || date > existingDate) byWho.set(task.WhoId, task);
  }
  const whoIds = [...byWho.keys()];
  const summary: RefreshSummary = { scanned: whoIds.length, added: 0, skippedReplied: 0, skippedActivity: 0 };
  if (whoIds.length === 0) return summary;

  // Already queued contacts are left alone.
  const { data: existingRows } = await supabase
    .from("inmail_queue")
    .select("who_id")
    .in("who_id", whoIds);
  const known = new Set((existingRows ?? []).map((r: { who_id: string }) => r.who_id));
  const fresh = whoIds.filter((id) => !known.has(id));
  if (fresh.length === 0) return summary;

  // Every task on these contacts: E1 bodies, and anything after the E5 that
  // signals a reply or manual follow-up (an inbound email, a call, a note).
  const idList = fresh.map((id) => `'${esc(id)}'`).join(",");
  const related = await sfQuery<TaskRecord>(
    `SELECT Id, Subject, Description, Subject_Type__c, ActivityDate, CompletedDateTime, Status, WhoId, AccountId ` +
      `FROM Task WHERE WhoId IN (${idList}) ORDER BY ActivityDate ASC`,
    credentials,
  );
  const relatedByWho = new Map<string, TaskRecord[]>();
  for (const task of related) {
    if (!task.WhoId) continue;
    const list = relatedByWho.get(task.WhoId) ?? [];
    list.push(task);
    relatedByWho.set(task.WhoId, list);
  }

  const linkedInField = await linkedInContactField();
  let linkedInByWho = new Map<string, string>();
  if (linkedInField) {
    try {
      const contacts = await sfQuery<{ Id: string } & Record<string, unknown>>(
        `SELECT Id, ${linkedInField} FROM Contact WHERE Id IN (${idList})`,
        credentials,
      );
      linkedInByWho = new Map(
        contacts
          .map((c) => [c.Id, c[linkedInField]] as [string, unknown])
          .filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].includes("linkedin.com")),
      );
    } catch {
      // Leads or a field that cannot be queried: fall back to the search link.
    }
  }

  const rows: Array<Partial<InMailQueueRow> & { who_id: string }> = [];
  for (const whoId of fresh) {
    const e5 = byWho.get(whoId)!;
    const e5Day = dayOf(e5.CompletedDateTime ?? e5.ActivityDate);
    const flags: string[] = [];

    // Reply guards. Responded__c on the account is the explicit signal.
    const responded = e5.Account?.Responded__c;
    if (responded === true || (typeof responded === "string" && responded.trim() && !/^(no|false|0)$/i.test(responded))) {
      summary.skippedReplied++;
      continue;
    }
    const tasks = relatedByWho.get(whoId) ?? [];
    const afterE5 = tasks.filter((t) => {
      const day = dayOf(t.CompletedDateTime ?? t.ActivityDate);
      return day && e5Day && day > e5Day && !/^E[1-5]$/.test(t.Subject_Type__c ?? "");
    });
    if (afterE5.length > 0) {
      // Activity after the sequence ended: probably a reply or a call. Skip it
      // rather than InMail someone who already answered.
      summary.skippedActivity++;
      continue;
    }
    if (e5.Account?.LastActivityDate && e5Day && e5.Account.LastActivityDate > e5Day) {
      flags.push(`Account had activity on ${e5.Account.LastActivityDate}, after the E5. Check before sending.`);
    }

    // The E1 that was actually sent: the latest completed E1 before this E5.
    const e1 = [...tasks]
      .filter((t) => t.Subject_Type__c === "E1" && t.Status === "Completed")
      .filter((t) => {
        const day = dayOf(t.CompletedDateTime ?? t.ActivityDate);
        return !day || !e5Day || day <= e5Day;
      })
      .pop();
    const e1Body = e1 ? cleanE1Body(e1.Description) : null;
    if (!e1Body) flags.push("No E1 body found in Salesforce for this contact.");

    const contactName = e5.Who?.Name ?? null;
    const firstName = firstNameOf(contactName);
    if (!firstName) flags.push("Could not determine the first name.");

    rows.push({
      who_id: whoId,
      account_id: e5.AccountId,
      account_name: e5.Account?.Name ?? null,
      contact_name: contactName,
      first_name: firstName,
      contact_email: e5.Who?.Email ?? null,
      e5_task_id: e5.Id,
      e5_sent_at: e5Day,
      e1_task_id: e1?.Id ?? null,
      e1_body: e1Body,
      linkedin_url: linkedInByWho.get(whoId) ?? null,
      navigator_url: contactName ? navigatorSearchUrl(contactName, e5.Account?.Name ?? null) : null,
      status: "pending",
      subject: inmailSubject(e5.Account?.Name ?? null),
      flags,
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("inmail_queue").upsert(rows, { onConflict: "who_id", ignoreDuplicates: true });
    if (error) throw new Error(`Could not save the InMail queue: ${error.message}`);
    summary.added = rows.length;
  }
  return summary;
}

export async function listInMailQueue(): Promise<InMailQueueRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("inmail_queue")
    .select("*")
    .neq("status", "dismissed")
    .order("e5_sent_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: InMailQueueRow) => ({ ...row, flags: Array.isArray(row.flags) ? row.flags : [] }));
}

/** Build both InMails for one queued contact from its Salesforce E1. */
export async function generateInMailFor(whoId: string): Promise<InMailQueueRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("inmail_queue").select("*").eq("who_id", whoId).single();
  if (error || !data) throw new Error("Queue row not found");
  const row = data as InMailQueueRow;
  if (!row.e1_body) throw new Error("This contact has no E1 body in Salesforce to work from.");
  const firstName = row.first_name ?? firstNameOf(row.contact_name);
  if (!firstName) throw new Error("First name unknown; set it before generating.");

  const client = getAnthropicClient();
  if (!client) throw new Error("AI service not configured (missing ANTHROPIC_API_KEY)");
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    system: INMAIL_SYSTEM_PROMPT,
    messages: [{ role: "user", content: inmailUserPrompt(firstName, row.e1_body) }],
  });
  const text = response.content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
  const parsed = parseInMailJson(text);
  const flags: string[] = (row.flags ?? []).filter((f) => !f.startsWith("Draft:"));
  let initial = parsed ? normalizeInMail(parsed.initial) : "";
  if (!parsed) flags.push("Draft: the model did not return usable JSON. Generate again.");
  const problems = initial ? validateInitialInMail({ text: initial, firstName, e1Body: row.e1_body }) : [];
  for (const problem of problems) flags.push(`Draft: ${problem}`);
  const followup = followUpTemplate(firstName);
  const status: InMailStatus = parsed && problems.length === 0 ? "generated" : "needs_review";

  const { data: updated, error: updateError } = await supabase
    .from("inmail_queue")
    .update({
      subject: row.subject ?? inmailSubject(row.account_name),
      initial_message: initial || null,
      followup_message: followup,
      flags,
      status: row.status === "sent" || row.status === "followup_sent" ? row.status : status,
      updated_at: new Date().toISOString(),
    })
    .eq("who_id", whoId)
    .select("*")
    .single();
  if (updateError || !updated) throw new Error(updateError?.message ?? "Could not save the draft");
  return updated as InMailQueueRow;
}

export async function updateInMailRow(
  whoId: string,
  changes: Partial<Pick<InMailQueueRow, "status" | "subject" | "initial_message" | "followup_message" | "linkedin_url" | "first_name">>,
): Promise<InMailQueueRow> {
  const patch: Record<string, unknown> = { ...changes, updated_at: new Date().toISOString() };
  if (changes.status === "sent") patch.sent_at = new Date().toISOString();
  if (changes.status === "followup_sent") patch.followup_sent_at = new Date().toISOString();
  if (changes.status === "pending") {
    patch.sent_at = null;
    patch.followup_sent_at = null;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("inmail_queue")
    .update(patch)
    .eq("who_id", whoId)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not update the row");
  return data as InMailQueueRow;
}

export { googleLinkedInUrl };
