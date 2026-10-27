/**
 * Open tasks come in two kinds:
 *   Reconnect: no real exchange with the company in the last 45 days.
 *   Nudge: they wrote within 45 days, or Seb spoke with them (a logged call
 *     or meeting: C1, RCC, F2F and their IB/Fund/D variants), so the task is a
 *     small push in a live relationship (NDA, data request, booking the call,
 *     checking in after something they said they would do).
 * A nudge is answered in the existing Outlook thread, drafted in Seb's voice;
 * on send the open task is completed and, optionally, a new one opened.
 */
import { addDays, format } from "date-fns";
import { trackedCreate } from "./model-cost";
import { getAnthropicClient, MODELS } from "./anthropic";
import { getValidCredentials } from "./token-manager";
import { assertSalesforceId, sfErrorText, sfFetch, sfQuery } from "./sf-query";
import { getSupabaseAdmin } from "./supabase";
import {
  createOutlookNewDraft,
  createOutlookReplyAllDraft,
  deleteOutlookDraftIfUnsent,
  fetchEmailThread,
  getMailboxIdentities,
  isSelfAddress,
  searchMailboxMessages,
  sendOutlookDraft,
} from "./microsoft";
import { trimReplyBody } from "./inbox-classify";
import { INBOX_DRAFT_SYSTEM } from "./inbox-draft";
import { buildRceFollowUp, firstNameFromGreeting, followUpCloser, greetingName, pickTemplateIndex, RCE_FOLLOW_UP_TEMPLATES } from "./rce-followup";

export const NUDGE_WINDOW_DAYS = 45;

/**
 * via "email" / "call": they engaged (wrote, or spoke with Seb) -> a Nudge.
 * via "sent": only Seb emailed them, no answer -> a Follow-up under his last email.
 */
export type NudgeInfo = { lastInAt: string; topic: string; via: "email" | "call" | "sent" };

const topicCache = new Map<string, { at: number; topic: string }>();

/** Logged conversations: first calls, reconnect calls, in-person meetings, any Call/Meeting task. */
const CONVERSATION_FILTER =
  "Subject_Type__c LIKE '%C1' OR Subject_Type__c LIKE '%C2' OR Subject_Type__c LIKE '%C3' OR Subject_Type__c LIKE '%RCC' " +
  "OR Subject_Type__c = 'F2F' OR Type IN ('Call', 'Meeting')";

/** Seb's outbound touches: sequence emails, reconnects, any logged email. */
const OUTBOUND_FILTER =
  "Subject_Type__c LIKE '%E1' OR Subject_Type__c LIKE '%E2' OR Subject_Type__c LIKE '%E3' OR Subject_Type__c LIKE '%E4' OR Subject_Type__c LIKE '%E5' " +
  "OR Subject_Type__c LIKE '%RCE%' OR Subject LIKE '%[Out]%' OR Type = 'Email'";

/**
 * Scheduling assistants and other bots copied on a thread (bot@blockit.com,
 * Calendly, no-reply senders). Never the person a nudge answers or addresses.
 */
const BOT_DOMAINS = ["blockit.com", "calendly.com", "chilipiper.com", "reclaim.ai", "x.ai", "clara.ai", "cal.com", "savvycal.com", "zcal.co", "motion.com", "outreach.io", "salesforce.com", "linkedin.com"];
export function isBotAddress(email: string | null | undefined): boolean {
  const e = (email ?? "").toLowerCase().trim();
  if (!e.includes("@")) return true;
  const [local, domain] = e.split("@");
  if (BOT_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return /^(bot|scheduler|scheduling|assistant|calendar|no-?reply|noreply|donotreply|do-not-reply|notifications?|mailer-daemon|postmaster|bounce)([.+-].*)?$/.test(local);
}

function since(): Date {
  return new Date(Date.now() - NUDGE_WINDOW_DAYS * 86_400_000);
}

/** accountId → nudge info, for the accounts that wrote in within the window. */
export async function classifyAccounts(accountIds: string[]): Promise<Record<string, NudgeInfo>> {
  const ids = Array.from(new Set(accountIds.filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id))));
  if (ids.length === 0) return {};
  const latest = new Map<string, { at: string; text: string; via: "email" | "call" }>();
  const sentOnly = new Map<string, string>();
  const keep = (id: string, at: string, text: string, via: "email" | "call" = "email") => {
    const prev = latest.get(id);
    if (!prev || prev.at < at) latest.set(id, { at, text, via });
  };

  // Salesforce: inbound emails logged by Outreach ("[Outreach] [Email] [In] ...").
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).map((id) => `'${id}'`).join(",");
    const rows = await sfQuery<{ WhatId: string; Subject: string | null; Description: string | null; ActivityDate: string | null; CreatedDate: string }>(
      `SELECT WhatId, Subject, Description, ActivityDate, CreatedDate FROM Task WHERE WhatId IN (${chunk}) ` +
        `AND Subject LIKE '%[In]%' AND CreatedDate = LAST_N_DAYS:${NUDGE_WINDOW_DAYS} ORDER BY CreatedDate DESC LIMIT 2000`,
    ).catch(() => []);
    for (const r of rows) keep(r.WhatId, r.CreatedDate, `${r.Subject ?? ""}\n${r.Description ?? ""}`);
    // Calls and meetings Seb logged: the subject holds the notes ("C1 - 20 FTE, ... check in after board").
    const calls = await sfQuery<{ WhatId: string; Subject: string | null; Description: string | null; ActivityDate: string | null; CreatedDate: string }>(
      `SELECT WhatId, Subject, Description, ActivityDate, CreatedDate FROM Task WHERE WhatId IN (${chunk}) AND Status = 'Completed' ` +
        `AND (${CONVERSATION_FILTER}) AND ActivityDate = LAST_N_DAYS:${NUDGE_WINDOW_DAYS} ORDER BY ActivityDate DESC LIMIT 2000`,
    ).catch(() => []);
    for (const r of calls) keep(r.WhatId, `${r.ActivityDate ?? r.CreatedDate.slice(0, 10)}T12:00:00.000Z`, `CALL NOTES: ${r.Subject ?? ""}\n${r.Description ?? ""}`, "call");
    // Seb's own emails (E1-E5, RCEs, any logged outbound): only used when they never engaged.
    const sent = await sfQuery<{ WhatId: string; ActivityDate: string | null; CreatedDate: string }>(
      `SELECT WhatId, ActivityDate, CreatedDate FROM Task WHERE WhatId IN (${chunk}) AND Status = 'Completed' ` +
        `AND (NOT Subject LIKE '%[In]%') AND (${OUTBOUND_FILTER}) AND ActivityDate = LAST_N_DAYS:${NUDGE_WINDOW_DAYS} ORDER BY ActivityDate DESC LIMIT 2000`,
    ).catch(() => []);
    for (const r of sent) {
      const at = `${r.ActivityDate ?? r.CreatedDate.slice(0, 10)}T12:00:00.000Z`;
      const prev = sentOnly.get(r.WhatId);
      if (!prev || prev < at) sentOnly.set(r.WhatId, at);
    }
  }

  // The app's Inbox: replies matched to an account.
  const { data } = await getSupabaseAdmin()
    .from("inbox_replies")
    .select("account_id, received_at, subject, preview")
    .in("account_id", ids)
    .gte("received_at", since().toISOString());
  for (const r of (data ?? []) as Array<{ account_id: string; received_at: string; subject: string | null; preview: string | null }>) {
    keep(r.account_id, r.received_at, `${r.subject ?? ""}\n${r.preview ?? ""}`);
  }

  const out: Record<string, NudgeInfo> = {};
  // Follow-ups first; an account where they engaged is overwritten below as a Nudge.
  for (const [id, at] of sentOnly) if (!latest.has(id)) out[id] = { lastInAt: at, topic: "follow-up", via: "sent" };
  const needTopic: Array<{ id: string; text: string }> = [];
  for (const [id, v] of latest) {
    const cached = topicCache.get(`${id}:${v.at}`);
    out[id] = { lastInAt: v.at, topic: cached?.topic ?? "follow-up", via: v.via };
    if (!cached) needTopic.push({ id, text: v.text.slice(0, 700) });
  }
  if (needTopic.length > 0) {
    const topics = await labelTopics(needTopic).catch(() => ({} as Record<string, string>));
    for (const { id } of needTopic) {
      const topic = topics[id] ?? "follow-up";
      out[id].topic = topic;
      topicCache.set(`${id}:${out[id].lastInAt}`, { at: Date.now(), topic });
    }
  }
  return out;
}

const TOPICS = ["NDA", "data request", "book the call", "after the call", "follow-up"];

async function labelTopics(items: Array<{ id: string; text: string }>): Promise<Record<string, string>> {
  const client = getAnthropicClient();
  if (!client) return {};
  const list = items.map((i, n) => `#${n} ${i.text.replace(/\s+/g, " ")}`).join("\n\n");
  const res = await trackedCreate(client, "nudges", {
    model: MODELS.extraction,
    max_tokens: 400,
    system: `Each item is the latest exchange with a company an acquirer is courting: either the company's latest email, or the acquirer's own notes from a call ("CALL NOTES:"). Label what the acquirer's next nudge is about, one of: ${TOPICS.join(", ")}. "book the call" = they agreed or were open to speaking but no time is set. "NDA" = an NDA is being reviewed or signed. "data request" = financials or information are being shared or requested. "after the call" = a call happened and the next step is a check-in they agreed to (after a board meeting, a deck, a decision). Otherwise "follow-up". Answer JSON only: {"0":"NDA","1":"follow-up"}`,
    messages: [{ role: "user", content: list }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, string>;
  const out: Record<string, string> = {};
  items.forEach((item, n) => {
    const t = parsed[String(n)];
    if (t && TOPICS.includes(t)) out[item.id] = t;
  });
  return out;
}

export type NudgeThreadMessage = { from: string; email: string; at: string; mine: boolean; text: string };
export type PreparedNudge = {
  /** Null: no thread with them in Outlook, so the nudge goes as a new email. */
  replyToMessageId: string | null;
  sender: { name: string | null; email: string };
  subject: string;
  thread: NudgeThreadMessage[];
  body: string;
  /** Latest logged call or meeting in the window, when there is one. */
  callNotes: { date: string; text: string } | null;
  /** Set when the thread says a nudge is the wrong move (they declined, or Seb already followed up). */
  advice?: string | null;
  /** Set when the AI draft failed and the standard line was used instead. */
  draftNote?: string | null;
};

function domainOfWebsite(website: string | null): string | null {
  if (!website) return null;
  try {
    const host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname;
    return host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Find the live thread with the company and draft the nudge. */
export async function prepareNudge(params: { accountId: string; accountName: string; website: string | null; topic: string; via?: NudgeInfo["via"] }): Promise<PreparedNudge> {
  assertSalesforceId(params.accountId, "account id");
  const identities = await getMailboxIdentities();
  const domains = new Set<string>();
  const site = domainOfWebsite(params.website);
  if (site) domains.add(site);
  const contacts = await sfQuery<{ Name: string | null; FirstName: string | null; Email: string | null; LastModifiedDate: string }>(
    `SELECT Name, FirstName, Email, LastModifiedDate FROM Contact WHERE AccountId = '${params.accountId}' AND Email != null ORDER BY LastModifiedDate DESC LIMIT 30`,
  ).catch(() => []);
  const contactEmails = new Set(contacts.map((c) => (c.Email ?? "").toLowerCase()).filter(Boolean));
  for (const e of contactEmails) domains.add(e.split("@")[1]);

  // Latest logged call or meeting in the window: its notes steer the draft.
  const calls = await sfQuery<{ Subject: string | null; Description: string | null; ActivityDate: string | null; Who: { Name?: string; Email?: string } | null }>(
    `SELECT Subject, Description, ActivityDate, Who.Name, Who.Email FROM Task WHERE WhatId = '${params.accountId}' AND Status = 'Completed' ` +
      `AND (${CONVERSATION_FILTER}) AND ActivityDate = LAST_N_DAYS:${NUDGE_WINDOW_DAYS} ORDER BY ActivityDate DESC LIMIT 1`,
  ).catch(() => []);
  const call = calls[0] ?? null;
  const callNotes = call ? { date: call.ActivityDate ?? "", text: `${call.Subject ?? ""}${call.Description ? `\n${call.Description}` : ""}`.trim().slice(0, 2000) } : null;
  const callEmail = call?.Who?.Email?.toLowerCase() ?? null;
  if (callEmail) domains.add(callEmail.split("@")[1]);

  // A thread to reply in: their latest email in the window first; otherwise the
  // latest thread with them in either direction, any age (a call often follows
  // an older email chain). None at all: a new email.
  const cutoff = since().toISOString();
  let theirs: { conversationId: string; at: string } | null = null;
  let anyThread: { conversationId: string; at: string } | null = null;
  let lastSentTo: string | null = null;
  let lastSentAt = "";
  // Search by each person first ("participants:" covers from, to and cc), then
  // by domain. Search results are ranked, not dated, so a broad domain search
  // alone can miss last week's email; a per-person search is narrow enough to
  // hold every message with that person.
  const people = [...new Set([callEmail, ...contactEmails].filter((e): e is string => Boolean(e) && !isBotAddress(e)))].slice(0, 8);
  const searches: Array<{ d: string; term: string }> = [
    ...people.map((e) => ({ d: e.split("@")[1], term: `participants:${e}` })),
    ...[...domains].map((d) => ({ d, term: d })),
  ];
  const seen = new Set<string>();
  for (const { d, term } of searches) {
    const found = (await searchMailboxMessages(term, 50).catch(() => [])).filter((m) => !seen.has(m.id) && (seen.add(m.id), true));
    for (const m of found) {
      if (!m.conversationId) continue;
      const fromThem = m.fromEmail && !isSelfAddress(m.fromEmail, identities) && !isBotAddress(m.fromEmail) && (m.fromEmail.endsWith(`@${d}`) || contactEmails.has(m.fromEmail));
      const toThem = isSelfAddress(m.fromEmail, identities) && m.toEmails.some((t) => !isBotAddress(t) && (t.endsWith(`@${d}`) || contactEmails.has(t)));
      if (fromThem && m.sentDateTime >= cutoff && (!theirs || theirs.at < m.sentDateTime)) theirs = { conversationId: m.conversationId, at: m.sentDateTime };
      if ((fromThem || toThem) && (!anyThread || anyThread.at < m.sentDateTime)) anyThread = { conversationId: m.conversationId, at: m.sentDateTime };
      if (toThem && m.sentDateTime > lastSentAt) {
        lastSentAt = m.sentDateTime;
        lastSentTo = m.toEmails.find((t) => !isBotAddress(t) && (t.endsWith(`@${d}`) || contactEmails.has(t))) ?? null;
      }
    }
  }
  // The most recent conversation with them wins, whoever wrote last: that is
  // where the relationship actually stands.
  const pick = anyThread ?? theirs;
  void theirs;

  // Follow-up: Seb emailed, they never answered. Reply under his latest email
  // with one of his own follow-up lines (fixed text, no model).
  if (params.via === "sent") {
    if (!anyThread) throw new Error(`Couldn't find your last email to ${params.accountName} in Outlook.`);
    const full = (await fetchEmailThread(anyThread.conversationId)).filter((e) => isSelfAddress(e.from.email, identities) || !isBotAddress(e.from.email));
    const mine = [...full].reverse().find((e) => isSelfAddress(e.from.email, identities));
    const last = full[full.length - 1];
    if (!mine || !last) throw new Error("Outlook couldn't return that thread.");
    // Who it went to: the address on Seb's last email to them, else a contact on the account.
    const toEmail = lastSentTo ?? callEmail ?? [...contactEmails][0] ?? null;
    if (!toEmail) throw new Error(`No contact email for ${params.accountName}.`);
    const contact = contacts.find((c) => (c.Email ?? "").toLowerCase() === toEmail);
    const first = contact?.FirstName ?? greetingName(contact?.Name ?? null, toEmail) ?? firstNameFromGreeting(trimReplyBody(mine.bodyText || mine.bodyPreview));
    const thread: NudgeThreadMessage[] = full.map((e) => ({ from: e.from.name, email: e.from.email, at: e.receivedDateTime, mine: isSelfAddress(e.from.email, identities), text: trimReplyBody(e.bodyText || e.bodyPreview) }));
    const fallback = freshTemplate(params.accountId, first, thread);
    const { body, advice } = await draftFollowUp(thread, params.accountName, first, fallback);
    return { replyToMessageId: last.id, sender: { name: contact?.Name ?? null, email: toEmail }, subject: last.subject, thread: thread.slice(-3), body, callNotes: null, advice };
  }

  if (pick) {
    // Bot messages (a scheduling assistant's "already booked" note) are dropped:
    // the nudge answers the last real person, or sits under Seb's own email.
    const full = (await fetchEmailThread(pick.conversationId)).filter((e) => isSelfAddress(e.from.email, identities) || !isBotAddress(e.from.email));
    if (full.length > 0) {
      const thread: NudgeThreadMessage[] = full.map((e) => ({
        from: e.from.name,
        email: e.from.email,
        at: e.receivedDateTime,
        mine: isSelfAddress(e.from.email, identities),
        text: trimReplyBody(e.bodyText || e.bodyPreview),
      }));
      const last = full[full.length - 1];
      const theirLast = [...full].reverse().find((e) => !isSelfAddress(e.from.email, identities)) ?? null;
      const toContact = lastSentTo ?? callEmail ?? [...contactEmails][0] ?? "";
      const sender = theirLast
        ? { name: theirLast.from.name || null, email: theirLast.from.email }
        : { name: contacts.find((c) => (c.Email ?? "").toLowerCase() === toContact)?.Name ?? call?.Who?.Name ?? null, email: toContact };
      if (!sender.email) throw new Error(`No email address for anyone at ${params.accountName}.`);
      const { body, note } = await draftNudge(thread, params.accountName, params.topic, sender.name, callNotes);
      return { replyToMessageId: last.id, sender, subject: last.subject, thread: thread.slice(-4), body, callNotes, draftNote: note };
    }
  }

  // No thread with them in Outlook: a new email to the person on the call, or the most recent contact.
  const person = callEmail
    ? { name: call?.Who?.Name ?? null, email: callEmail }
    : contacts[0]?.Email
      ? { name: contacts[0].Name, email: contacts[0].Email.toLowerCase() }
      : null;
  if (!person) throw new Error(`No email thread and no contact email for ${params.accountName}.`);
  const { body, note } = await draftNudge([], params.accountName, params.topic, person.name, callNotes);
  return { replyToMessageId: null, sender: person, subject: `Valstone / ${params.accountName}`, thread: [], body, callNotes, draftNote: note };
}

/**
 * A follow-up under Seb's own unanswered email. Reads the thread so it can
 * pick up something concrete (a trip, a group, a question he asked); written
 * in the style of his own follow-up lines, never longer than two sentences.
 * Falls back to one of those lines verbatim.
 */
/** One of Seb's follow-up lines that he has not already used in this thread. */
function freshTemplate(seed: string, first: string | null, thread: NudgeThreadMessage[]): string {
  const said = thread.filter((m) => m.mine).map((m) => m.text.toLowerCase().replace(/\s+/g, " "));
  const start = pickTemplateIndex(seed);
  for (let k = 0; k < RCE_FOLLOW_UP_TEMPLATES.length; k++) {
    const i = (start + k) % RCE_FOLLOW_UP_TEMPLATES.length;
    const key = RCE_FOLLOW_UP_TEMPLATES[i].body.split("\n").pop()!.toLowerCase().slice(0, 40);
    if (!said.some((t) => t.includes(key))) return buildRceFollowUp({ seed, firstName: first, now: new Date(), templateIndex: i }).body;
  }
  return buildRceFollowUp({ seed, firstName: first, now: new Date() }).body;
}

/**
 * A follow-up under Seb's own unanswered email. The model reads the thread:
 * it writes something new (never a line Seb already sent), picks up a concrete
 * detail when there is one, and says plainly when a follow-up is the wrong
 * move (they said they are not selling, or Seb has already followed up twice).
 */
async function draftFollowUp(thread: NudgeThreadMessage[], accountName: string, first: string | null, fallback: string): Promise<{ body: string; advice: string | null }> {
  const client = getAnthropicClient();
  if (!client || thread.length === 0) return { body: fallback, advice: null };
  const lines = thread.slice(-6).map((m) => `--- ${m.mine ? "SEB" : m.from || m.email}, ${m.at.slice(0, 10)} ---\n${m.text.trim().slice(0, 1800)}`);
  const closer = followUpCloser(new Date());
  try {
    const res = await trackedCreate(client, "nudges", {
      model: MODELS.drafting,
      max_tokens: 1200,
      system: `${INBOX_DRAFT_SYSTEM}

This one is a FOLLOW-UP under Seb's own unanswered email. Read the whole thread first.

1. Decide whether another nudge makes sense. It does NOT when they said they are not selling or not interested (respect it), or when Seb's last two or more emails are already unanswered follow-ups. In that case write "advice": one short sentence for Seb (e.g. "John said TowWorks isn't for sale and you've followed up twice since. Push this task out a few months instead of nudging."), and still write the gentlest possible body in case he sends anyway (no ask, just staying in touch, or none at all).
2. The body must be NEW. Never repeat or lightly reword a sentence Seb already sent in this thread (check every SEB message). Do not reuse these stock lines either: "Following up once more", "Following up a final time", "Quickly following up on my last email", "Our interest remains strong".
3. Pick up one concrete thing from the thread when there is one (a date, a trip, the group, something they said), in a few words. One or two short sentences. Calm, never needy, no apology.
Greeting: ${first ? `"Hi ${first},"` : "no name, just start"}. Closing: "${closer}" then "Seb" on its own line.

Answer JSON only: {"advice": null or "one sentence", "body": "the email"}`,
      messages: [{ role: "user", content: `Company: ${accountName}\n\nThread, oldest first. Reply under the last SEB email:\n\n${lines.join("\n\n")}` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { advice?: string | null; body?: string };
    const body = (parsed.body ?? "").trim().replace(/[–—]/g, ",");
    const advice = parsed.advice && String(parsed.advice).trim() ? String(parsed.advice).trim().replace(/[–—]/g, ",") : null;
    // Guard: if the model still echoed a sentence Seb already sent, use a fresh template line.
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
    const sent = thread.filter((m) => m.mine).map((m) => norm(m.text));
    const echoes = body.split(/(?<=[.?!])\s+/).map(norm).filter((x) => x.length > 25).some((x) => sent.some((t) => t.includes(x)));
    return { body: body && body.length < 800 && !echoes ? body : fallback, advice };
  } catch {
    return { body: fallback, advice: null };
  }
}

async function draftNudge(
  thread: NudgeThreadMessage[],
  accountName: string,
  topic: string,
  theirName: string | null,
  callNotes: { date: string; text: string } | null = null,
): Promise<{ body: string; note: string | null }> {
  const first = (theirName ?? "").trim().split(/\s+/)[0] || null;
  const fallback = `Hi${first ? ` ${first}` : ""},\n\nJust checking in${callNotes ? " after our call" : " on this"}. ${
    topic === "book the call" ? "Would love to get a call on the calendar. Does next week work?" : topic === "NDA" ? "Any questions on the NDA on your end?" : topic === "data request" ? "Any colour you can share on timing for the information would be helpful on our end." : "Any update on your side?"
  }\n\nBest,\nSebastian`;
  const client = getAnthropicClient();
  if (!client) return { body: fallback, note: "Standard draft: no AI key configured." };
  const lines = thread.slice(-5).map((m) => `--- ${m.mine ? "SEB" : m.from || m.email}, ${m.at.slice(0, 10)} ---\n${m.text.trim().slice(0, 1800)}`);
  const parts = [`Company: ${accountName}`];
  if (callNotes) parts.push(`Seb's own notes from his latest call with them (${callNotes.date}), shorthand, for context only, never quote them:\n${callNotes.text}`);
  parts.push(lines.length > 0 ? `Email thread, oldest first. The nudge is a reply in this thread:\n\n${lines.join("\n\n")}` : "No email thread with them: this is a new email.");
  try {
    const res = await trackedCreate(client, "nudges", {
      model: MODELS.drafting,
      max_tokens: 1200,
      system: `${INBOX_DRAFT_SYSTEM}

This one is a NUDGE: Seb is moving a live relationship to its next step. Topic: ${topic}. One to three short sentences in the body. Calm, not anxious. Pick up the concrete open item: from the call notes when there are any (what they said they would do, e.g. check back after their board meeting), otherwise from the thread (the NDA, the information they said they'd send, the call they agreed to). Refer to the call naturally ("Good speaking earlier this month") without repeating details they already know. For booking a call, ask plainly for a time next week; do not mention a scheduling tool. Address it to ${first ?? "them"}.`,
      messages: [{ role: "user", content: parts.join("\n\n") }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().replace(/[–—]/g, ",");
    return text ? { body: text, note: null } : { body: fallback, note: "Standard draft: the AI returned nothing." };
  } catch (err) {
    console.error("[nudges] draft failed", err);
    return { body: fallback, note: `Standard draft: the AI draft failed (${err instanceof Error ? err.message.slice(0, 120) : "unknown"}).` };
  }
}

/** Send in the thread, then complete the open task and open the next one if asked. */
export async function sendNudge(params: {
  replyToMessageId: string | null;
  /** Subject for a new email (no thread to reply in). */
  emailSubject?: string;
  sender: { name: string | null; email: string };
  body: string;
  taskId: string;
  accountId: string;
  subject: string;
  days: number | null;
}): Promise<{ notes: string[]; newTaskDate: string | null }> {
  const body = params.body.trim();
  if (!body) throw new Error("The email is empty.");
  const identities = await getMailboxIdentities();
  if (!params.sender?.email || isSelfAddress(params.sender.email, identities)) throw new Error("No recipient for this nudge. Nothing was sent.");
  const draft = params.replyToMessageId
    ? await createOutlookReplyAllDraft(params.replyToMessageId, body, { selfAddresses: identities, sender: params.sender })
    : { ...(await createOutlookNewDraft({ to: params.sender.email, subject: params.emailSubject || "Valstone", body })), recipients: [params.sender] };
  const to = draft.recipients ?? [];
  if (to.length === 0 || to.every((r) => isSelfAddress(r.email, identities))) {
    await deleteOutlookDraftIfUnsent(draft.id).catch(() => undefined);
    throw new Error("The reply came out addressed to you. Nothing was sent.");
  }
  try {
    await sendOutlookDraft(draft.id);
  } catch (err) {
    await deleteOutlookDraftIfUnsent(draft.id).catch(() => undefined);
    throw err;
  }

  const notes: string[] = [];
  let newTaskDate: string | null = null;
  try {
    const credentials = await getValidCredentials();
    if (!credentials) throw new Error("Salesforce not connected");
    const taskId = assertSalesforceId(params.taskId, "task id");
    const accountId = assertSalesforceId(params.accountId, "account id");
    const done = await sfFetch(`/services/data/v62.0/sobjects/Task/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ Status: "Completed", ActivityDate: format(new Date(), "yyyy-MM-dd"), Subject_Type__c: "RCE1", Description: body.slice(0, 30000) }),
    }, credentials);
    if (!done.ok) notes.push(`Completing the task failed: ${await sfErrorText(done)}`);
    if (params.days && params.days > 0) {
      newTaskDate = format(addDays(new Date(), params.days), "yyyy-MM-dd");
      const created = await sfFetch(`/services/data/v62.0/sobjects/Task`, {
        method: "POST",
        body: JSON.stringify({
          Subject: params.subject,
          Status: "Open",
          Priority: "Normal",
          ActivityDate: newTaskDate,
          WhatId: accountId,
          OwnerId: credentials.salesforce_user_id,
          Subject_Type__c: "RCE1",
        }),
      }, credentials);
      if (!created.ok) {
        notes.push(`Opening the next task failed: ${await sfErrorText(created)}`);
        newTaskDate = null;
      }
    }
  } catch (err) {
    notes.push(`Salesforce: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { notes, newTaskDate };
}
