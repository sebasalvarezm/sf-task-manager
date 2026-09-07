import { getValidCredentials } from "./token-manager";
import { sfQuery } from "./sf-query";

/**
 * The account's Salesforce activity timeline, read the way a person reads it.
 *
 * The old `fetchRecentAccountActivity` pulled subject, description and status
 * only. Without who sent what to whom, a colleague's February exchange with the
 * target looked like anonymous text, so the RCE drafter could not tell a
 * takeover from a thread of the user's own. This module pulls Task AND
 * EmailMessage records with names and direction, and works out whether the
 * user is picking the relationship up from someone else.
 */

export type AccountHistoryEntry = {
  date: string;
  /** "task" for logged activities, "email" for EmailMessage records. */
  kind: "task" | "email";
  subject: string;
  body: string;
  /** Valstone-side person: Task owner, or EmailMessage sender/creator. */
  ownerName: string | null;
  ownerId: string | null;
  /** Target-side person, when Salesforce knows them. */
  contactName: string | null;
  contactEmail: string | null;
  /** "out" = Valstone wrote to them, "in" = they wrote to Valstone, null = unknown. */
  direction: "in" | "out" | null;
  /** True for email-type activities (Outreach syncs, E1-E5 tasks, EmailMessage). */
  isEmail: boolean;
};

export type AccountTakeover = {
  /** Colleague who last exchanged with the target. */
  colleagueName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactFirstName: string | null;
  /** ISO date of the last exchange in the colleague's chain. */
  lastExchangeDate: string;
  /** Count of email exchanges in the colleague's chain. */
  exchangeCount: number;
};

export type AccountHistory = {
  entries: AccountHistoryEntry[];
  /** Plain text lines, newest first, ready to paste into a prompt. */
  lines: string[];
  /** The signed-in Salesforce user, so the prompt can tell "me" from colleagues. */
  currentUserName: string | null;
  /** Set when the exchanges belong to a colleague and the user has none of their own. */
  takeover: AccountTakeover | null;
};

const EMPTY: AccountHistory = { entries: [], lines: [], currentUserName: null, takeover: null };

function escapeSoql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function firstName(fullName: string | null): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0];
  return first || null;
}

function firstAddress(list: string | null | undefined): string | null {
  if (!list) return null;
  const first = list.split(/[;,\s]+/).find(Boolean);
  return first ? first.toLowerCase() : null;
}

/** Outreach and the team both tag email tasks in the subject; TaskSubtype covers Enhanced Email. */
function looksLikeEmail(subject: string, subtype: string | null | undefined, type: string | null | undefined): boolean {
  if (subtype === "Email") return true;
  if (type === "Email") return true;
  return /\[outreach\]|\[email\]|\[e[1-5]\]|^re:|^fwd?:|^email/i.test(subject);
}

function directionFromSubject(subject: string): "in" | "out" | null {
  if (/\[in\]/i.test(subject)) return "in";
  if (/\[out\]/i.test(subject)) return "out";
  return null;
}

type TaskRow = {
  Id: string;
  Subject?: string | null;
  Description?: string | null;
  ActivityDate?: string | null;
  CreatedDate?: string | null;
  Status?: string | null;
  Type?: string | null;
  TaskSubtype?: string | null;
  OwnerId?: string | null;
  Owner?: { Name?: string | null } | null;
  Who?: { Name?: string | null; Email?: string | null } | null;
};

type EmailRow = {
  Id: string;
  Subject?: string | null;
  TextBody?: string | null;
  MessageDate?: string | null;
  CreatedDate?: string | null;
  FromAddress?: string | null;
  FromName?: string | null;
  ToAddress?: string | null;
  Incoming?: boolean | null;
  CreatedById?: string | null;
  CreatedBy?: { Name?: string | null } | null;
};

async function fetchTasks(accountId: string, limit: number): Promise<TaskRow[]> {
  const id = escapeSoql(accountId);
  const withSubtype =
    `SELECT Id, Subject, Description, ActivityDate, CreatedDate, Status, Type, TaskSubtype, ` +
    `OwnerId, Owner.Name, Who.Name, Who.Email ` +
    `FROM Task WHERE WhatId = '${id}' OR AccountId = '${id}' ` +
    `ORDER BY CreatedDate DESC LIMIT ${limit}`;
  try {
    return await sfQuery<TaskRow>(withSubtype);
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_CONNECTED") throw err;
  }
  // Some orgs hide TaskSubtype from the API. Retry without it.
  const plain =
    `SELECT Id, Subject, Description, ActivityDate, CreatedDate, Status, Type, ` +
    `OwnerId, Owner.Name, Who.Name, Who.Email ` +
    `FROM Task WHERE WhatId = '${id}' OR AccountId = '${id}' ` +
    `ORDER BY CreatedDate DESC LIMIT ${limit}`;
  try {
    return await sfQuery<TaskRow>(plain);
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_CONNECTED") throw err;
    return [];
  }
}

async function fetchEmails(accountId: string, limit: number): Promise<EmailRow[]> {
  const id = escapeSoql(accountId);
  const soql =
    `SELECT Id, Subject, TextBody, MessageDate, CreatedDate, FromAddress, FromName, ToAddress, ` +
    `Incoming, CreatedById, CreatedBy.Name ` +
    `FROM EmailMessage WHERE RelatedToId = '${id}' ` +
    `ORDER BY MessageDate DESC LIMIT ${limit}`;
  try {
    return await sfQuery<EmailRow>(soql);
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_CONNECTED") throw err;
    // Orgs without Enhanced Email have no EmailMessage records tied to accounts.
    return [];
  }
}

async function fetchUserName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const rows = await sfQuery<{ Name?: string | null }>(
      `SELECT Name FROM User WHERE Id = '${escapeSoql(userId)}' LIMIT 1`,
    );
    return rows[0]?.Name ?? null;
  } catch {
    return null;
  }
}

function taskToEntry(row: TaskRow): AccountHistoryEntry {
  const subject = row.Subject?.trim() || "Activity";
  return {
    date: row.ActivityDate ?? row.CreatedDate?.slice(0, 10) ?? "",
    kind: "task",
    subject,
    body: (row.Description ?? "").trim().slice(0, 2000),
    ownerName: row.Owner?.Name ?? null,
    ownerId: row.OwnerId ?? null,
    contactName: row.Who?.Name ?? null,
    contactEmail: row.Who?.Email?.toLowerCase() ?? null,
    direction: directionFromSubject(subject),
    isEmail: looksLikeEmail(subject, row.TaskSubtype, row.Type),
  };
}

function emailToEntry(row: EmailRow, valstoneDomain: string | null): AccountHistoryEntry {
  const incoming = row.Incoming === true;
  const from = row.FromAddress?.toLowerCase() ?? null;
  const to = firstAddress(row.ToAddress);
  const fromIsValstone = valstoneDomain && from ? from.endsWith(valstoneDomain) : !incoming;
  return {
    date: (row.MessageDate ?? row.CreatedDate ?? "").slice(0, 10),
    kind: "email",
    subject: row.Subject?.trim() || "(No subject)",
    body: (row.TextBody ?? "").trim().slice(0, 2000),
    ownerName: fromIsValstone ? row.FromName ?? row.CreatedBy?.Name ?? null : row.CreatedBy?.Name ?? null,
    ownerId: row.CreatedById ?? null,
    contactName: fromIsValstone ? null : row.FromName ?? null,
    contactEmail: fromIsValstone ? to : from,
    direction: fromIsValstone ? "out" : "in",
    isEmail: true,
  };
}

function formatLine(entry: AccountHistoryEntry, currentUserName: string | null): string {
  const who = entry.ownerName
    ? entry.ownerName === currentUserName
      ? `${entry.ownerName} (me)`
      : `${entry.ownerName} (colleague)`
    : "unknown Valstone person";
  const contact = entry.contactName
    ? `${entry.contactName}${entry.contactEmail ? ` <${entry.contactEmail}>` : ""}`
    : entry.contactEmail ?? "the company";
  const arrow = entry.direction === "in" ? `${contact} -> ${who}` : `${who} -> ${contact}`;
  const body = entry.body ? `\n${entry.body}` : "";
  return `${entry.date || "unknown date"} | ${entry.kind} | ${arrow} | ${entry.subject}${body}`;
}

/**
 * Decide whether the user is taking this relationship over from a colleague.
 *
 * Takeover means: there is at least one email exchange on the account, every
 * one of them belongs to someone other than the signed-in user, and the user
 * has none. If the user has even one email of their own, the relationship is
 * already theirs and the Outlook search (not this) should carry the context.
 */
function detectTakeover(entries: AccountHistoryEntry[], currentUserId: string | null, currentUserName: string | null): AccountTakeover | null {
  const emails = entries.filter((entry) => entry.isEmail && entry.ownerName);
  if (emails.length === 0) return null;
  const isMine = (entry: AccountHistoryEntry) =>
    (currentUserId && entry.ownerId === currentUserId) ||
    (currentUserName && entry.ownerName === currentUserName);
  if (emails.some(isMine)) return null;

  const latest = emails[0];
  const colleagueName = latest.ownerName as string;
  const chain = emails.filter((entry) => entry.ownerName === colleagueName);
  const contactEntry = chain.find((entry) => entry.contactName) ?? chain.find((entry) => entry.contactEmail) ?? null;
  const contactName = contactEntry?.contactName ?? null;
  return {
    colleagueName,
    contactName,
    contactEmail: contactEntry?.contactEmail ?? null,
    contactFirstName: firstName(contactName),
    lastExchangeDate: latest.date,
    exchangeCount: chain.length,
  };
}

/**
 * Read the account timeline. Fails soft to an empty history on any Salesforce
 * error except NOT_CONNECTED, matching the old helper's behavior.
 */
export async function fetchAccountHistory(
  accountId: string,
  options: { limit?: number; valstoneDomain?: string | null } = {},
): Promise<AccountHistory> {
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const limit = options.limit ?? 20;
  const valstoneDomain = options.valstoneDomain?.toLowerCase() ?? null;

  const [tasks, emails, currentUserName] = await Promise.all([
    fetchTasks(accountId, limit),
    fetchEmails(accountId, limit),
    fetchUserName(credentials.salesforce_user_id),
  ]);
  if (tasks.length === 0 && emails.length === 0) return { ...EMPTY, currentUserName };

  const entries = [
    ...tasks.map(taskToEntry),
    ...emails.map((row) => emailToEntry(row, valstoneDomain)),
  ]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, limit);

  return {
    entries,
    lines: entries.map((entry) => formatLine(entry, currentUserName)),
    currentUserName,
    takeover: detectTakeover(entries, credentials.salesforce_user_id, currentUserName),
  };
}
