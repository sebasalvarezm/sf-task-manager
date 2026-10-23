/**
 * Open tasks come in two kinds:
 *   Reconnect: nobody at the company has emailed Seb in the last 45 days.
 *   Nudge: they wrote within 45 days, so the task is a small push in a live
 *     thread (NDA questions, data request, booking the call they agreed to).
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

export const NUDGE_WINDOW_DAYS = 45;

export type NudgeInfo = { lastInAt: string; topic: string };

const topicCache = new Map<string, { at: number; topic: string }>();

function since(): Date {
  return new Date(Date.now() - NUDGE_WINDOW_DAYS * 86_400_000);
}

/** accountId → nudge info, for the accounts that wrote in within the window. */
export async function classifyAccounts(accountIds: string[]): Promise<Record<string, NudgeInfo>> {
  const ids = Array.from(new Set(accountIds.filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id))));
  if (ids.length === 0) return {};
  const latest = new Map<string, { at: string; text: string }>();
  const keep = (id: string, at: string, text: string) => {
    const prev = latest.get(id);
    if (!prev || prev.at < at) latest.set(id, { at, text });
  };

  // Salesforce: inbound emails logged by Outreach ("[Outreach] [Email] [In] ...").
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).map((id) => `'${id}'`).join(",");
    const rows = await sfQuery<{ WhatId: string; Subject: string | null; Description: string | null; ActivityDate: string | null; CreatedDate: string }>(
      `SELECT WhatId, Subject, Description, ActivityDate, CreatedDate FROM Task WHERE WhatId IN (${chunk}) ` +
        `AND Subject LIKE '%[In]%' AND CreatedDate = LAST_N_DAYS:${NUDGE_WINDOW_DAYS} ORDER BY CreatedDate DESC LIMIT 2000`,
    ).catch(() => []);
    for (const r of rows) keep(r.WhatId, r.CreatedDate, `${r.Subject ?? ""}\n${r.Description ?? ""}`);
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
  const needTopic: Array<{ id: string; text: string }> = [];
  for (const [id, v] of latest) {
    const cached = topicCache.get(`${id}:${v.at}`);
    out[id] = { lastInAt: v.at, topic: cached?.topic ?? "follow-up" };
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

const TOPICS = ["NDA", "data request", "book the call", "follow-up"];

async function labelTopics(items: Array<{ id: string; text: string }>): Promise<Record<string, string>> {
  const client = getAnthropicClient();
  if (!client) return {};
  const list = items.map((i, n) => `#${n} ${i.text.replace(/\s+/g, " ")}`).join("\n\n");
  const res = await trackedCreate(client, "nudges", {
    model: MODELS.extraction,
    max_tokens: 400,
    system: `Each item is the latest email a company sent to an acquirer. Label what the acquirer's next nudge is about, one of: ${TOPICS.join(", ")}. "book the call" = they agreed or were open to speaking but no time is set. "NDA" = an NDA is being reviewed or signed. "data request" = financials or information are being shared or requested. Otherwise "follow-up". Answer JSON only: {"0":"NDA","1":"follow-up"}`,
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
  replyToMessageId: string;
  sender: { name: string | null; email: string };
  subject: string;
  thread: NudgeThreadMessage[];
  body: string;
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
export async function prepareNudge(params: { accountId: string; accountName: string; website: string | null; topic: string }): Promise<PreparedNudge> {
  assertSalesforceId(params.accountId, "account id");
  const identities = await getMailboxIdentities();
  const domains = new Set<string>();
  const site = domainOfWebsite(params.website);
  if (site) domains.add(site);
  const contacts = await sfQuery<{ Email: string | null }>(
    `SELECT Email FROM Contact WHERE AccountId = '${params.accountId}' AND Email != null LIMIT 30`,
  ).catch(() => []);
  const contactEmails = new Set(contacts.map((c) => (c.Email ?? "").toLowerCase()).filter(Boolean));
  for (const e of contactEmails) domains.add(e.split("@")[1]);

  // Latest message from them within the window, searched by domain.
  const cutoff = since().toISOString();
  let best: { conversationId: string; at: string } | null = null;
  for (const d of domains) {
    const found = await searchMailboxMessages(d, 25).catch(() => []);
    for (const m of found) {
      const fromThem = m.fromEmail && !isSelfAddress(m.fromEmail, identities) && (m.fromEmail.endsWith(`@${d}`) || contactEmails.has(m.fromEmail));
      if (!fromThem || !m.conversationId || m.sentDateTime < cutoff) continue;
      if (!best || best.at < m.sentDateTime) best = { conversationId: m.conversationId, at: m.sentDateTime };
    }
  }
  if (!best) throw new Error(`No email from ${params.accountName} in the last ${NUDGE_WINDOW_DAYS} days was found in Outlook.`);

  const full = await fetchEmailThread(best.conversationId);
  if (full.length === 0) throw new Error("Outlook couldn't return that thread.");
  const thread: NudgeThreadMessage[] = full.map((e) => ({
    from: e.from.name,
    email: e.from.email,
    at: e.receivedDateTime,
    mine: isSelfAddress(e.from.email, identities),
    text: trimReplyBody(e.bodyText || e.bodyPreview),
  }));
  const last = full[full.length - 1];
  const theirLast = [...full].reverse().find((e) => !isSelfAddress(e.from.email, identities)) ?? last;
  const body = await draftNudge(thread, params.accountName, params.topic, theirLast.from.name || null);
  return {
    replyToMessageId: last.id,
    sender: { name: theirLast.from.name || null, email: theirLast.from.email },
    subject: last.subject,
    thread: thread.slice(-4),
    body,
  };
}

async function draftNudge(thread: NudgeThreadMessage[], accountName: string, topic: string, theirName: string | null): Promise<string> {
  const first = (theirName ?? "").trim().split(/\s+/)[0] || null;
  const fallback = `Hi${first ? ` ${first}` : ""},\n\nJust checking in on this. ${
    topic === "book the call" ? "Would love to get a call on the calendar. Does next week work?" : topic === "NDA" ? "Any questions on the NDA on your end?" : topic === "data request" ? "Any colour you can share on timing for the information would be helpful on our end." : "Any update on your side?"
  }\n\nBest,\nSebastian`;
  const client = getAnthropicClient();
  if (!client) return fallback;
  const lines = thread.slice(-5).map((m) => `--- ${m.mine ? "SEB" : m.from || m.email}, ${m.at.slice(0, 10)} ---\n${m.text.trim().slice(0, 1800)}`);
  try {
    const res = await trackedCreate(client, "nudges", {
      model: MODELS.drafting,
      max_tokens: 300,
      system: `${INBOX_DRAFT_SYSTEM}

This one is a NUDGE: the thread went quiet and Seb is moving it to the next step. Topic: ${topic}. One to three short sentences in the body. Calm, not anxious. Pick up the concrete open item from the thread (the NDA, the information they said they'd send, the call they agreed to). For booking a call, ask plainly for a time next week; do not mention a scheduling tool. Never apologise for following up more than once briefly. Address it to ${first ?? "them"}.`,
      messages: [{ role: "user", content: `Company: ${accountName}\n\nThread, oldest first:\n\n${lines.join("\n\n")}` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().replace(/[–—]/g, ",");
    return text || fallback;
  } catch {
    return fallback;
  }
}

/** Send in the thread, then complete the open task and open the next one if asked. */
export async function sendNudge(params: {
  replyToMessageId: string;
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
  const draft = await createOutlookReplyAllDraft(params.replyToMessageId, body, { selfAddresses: identities, sender: params.sender });
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
