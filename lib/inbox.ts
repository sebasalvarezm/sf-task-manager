import {
  getMsValidCredentials,
  fetchEmailThread,
  getMailboxIdentities,
  isSelfAddress,
  createOutlookReplyAllDraft,
  sendOutlookDraft,
  deleteOutlookDraftIfUnsent,
} from "./microsoft";
import {
  BLOCKIT_CC,
  INBOX_DRAFT_SYSTEM,
  POSITIVE_DETAIL_SYSTEM,
  positiveDetailPrompt,
  positiveDraft,
  fallbackDraft,
  firstNameOfSender,
  inboxDraftPrompt,
  normalizeDraft,
  validateDraft,
} from "./inbox-draft";
import { markAccountResponded, scheduleRceTask, type RespondedOutcome } from "./inbox-salesforce";
import type { FollowUpOutcome } from "./salesforce-calls";
import { sfQuery } from "./sf-query";
import { getSupabaseAdmin } from "./supabase";
import { getAnthropicClient, MODELS } from "./anthropic";
import { escapeSoql, normalizeDomain, rankAccounts } from "./account-match";
import {
  INBOX_CLASSIFY_SYSTEM,
  companyFromSubject,
  domainOf,
  inboxClassifyPrompt,
  isAutomatedSender,
  isFreeMailDomain,
  parseClassification,
  suggestedNextTouch,
  addDays,
  trimReplyBody,
  type Classification,
  type Sentiment,
  type ThreadMessage,
} from "./inbox-classify";

/**
 * Inbox: inbound replies to outreach, one row per thread (its latest inbound
 * message), classified and matched to a Salesforce account.
 *
 * Reading and classifying never write anywhere. Sending (sendInboxReply) is
 * the one place that sends mail and touches Salesforce.
 */

export type InboxStatus = "new" | "drafted" | "sent" | "skipped";

export type InboxRow = {
  message_id: string;
  conversation_id: string;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  from_domain: string | null;
  received_at: string;
  preview: string | null;
  thread: ThreadMessage[];
  has_mine: boolean;
  account_id: string | null;
  account_name: string | null;
  account_matched_by: "contact" | "domain" | "subject" | null;
  sentiment: Sentiment | null;
  timing_text: string | null;
  suggested_date: string | null;
  summary: string | null;
  is_broker_intro: boolean;
  status: InboxStatus;
  draft_body: string | null;
  sent_at: string | null;
  sf_responded_at: string | null;
  task_id: string | null;
  task_date: string | null;
  created_at: string;
  updated_at: string;
};

type GraphMessage = {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime: string;
  bodyPreview?: string;
  body?: { content?: string };
  conversationId: string;
  isRead?: boolean;
  "@odata.type"?: string;
};

const CLASSIFY_MODEL = MODELS.extraction;
const DRAFT_MODEL = MODELS.drafting;

export async function listInbox(): Promise<InboxRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_replies")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as InboxRow[]).map((row) => {
    // Re-run the cutter on read: rows stored before it learned a pattern
    // (signature blocks, tracking links, legal footers) still come out clean.
    const thread = (row.thread ?? []).map((m) => ({ ...m, text: trimReplyBody(m.text) }));
    const latest = thread[thread.length - 1];
    return { ...row, thread, preview: latest ? latest.text.slice(0, 400) : row.preview };
  });
}

/** Unread inbound messages in the last `days` days, newest first. */
async function fetchUnreadInbound(days: number): Promise<GraphMessage[]> {
  const credentials = await getMsValidCredentials();
  if (!credentials) throw new Error("MS_NOT_CONNECTED");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const params = new URLSearchParams({
    $filter: `isRead eq false and receivedDateTime ge ${since}`,
    $select: "id,subject,from,receivedDateTime,bodyPreview,body,conversationId,isRead",
    $orderby: "receivedDateTime desc",
    $top: "100",
  });
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        Prefer: 'outlook.body-content-type="text"',
      },
    },
  );
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("OUTLOOK_RECONNECT_REQUIRED");
    throw new Error(`Outlook inbox read failed (${response.status})`);
  }
  const data = (await response.json()) as { value?: GraphMessage[] };
  return data.value ?? [];
}

type AccountHit = { accountId: string; accountName: string; website: string | null };

/**
 * Match senders to Salesforce accounts in one pass, in this order:
 * the sender is a Contact on the account (their email, exactly), the sender's
 * domain is the account's website, or the subject names the company.
 */
async function matchAccounts(
  emails: string[],
  domains: string[],
  subjectNames: string[],
): Promise<{ byEmail: Map<string, AccountHit>; byDomain: Map<string, AccountHit>; byName: Map<string, AccountHit> }> {
  const byEmail = new Map<string, AccountHit>();
  const byDomain = new Map<string, AccountHit>();
  const byName = new Map<string, AccountHit>();
  const uniqueEmails = Array.from(new Set(emails.filter(Boolean).map((e) => e.toLowerCase())));
  if (uniqueEmails.length > 0) {
    try {
      type ContactRec = { Email: string | null; AccountId: string | null; Account?: { Name?: string; Website?: string | null } | null };
      const contacts = await sfQuery<ContactRec>(
        `SELECT Email, AccountId, Account.Name, Account.Website FROM Contact WHERE AccountId != null AND Email IN (${uniqueEmails.map((e) => `'${escapeSoql(e)}'`).join(", ")}) LIMIT 200`,
      );
      for (const c of contacts) {
        const email = (c.Email ?? "").toLowerCase();
        if (email && c.AccountId && c.Account?.Name && !byEmail.has(email)) {
          byEmail.set(email, { accountId: c.AccountId, accountName: c.Account.Name, website: c.Account.Website ?? null });
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.message === "NOT_CONNECTED")) throw err;
    }
  }
  const uniqueDomains = Array.from(new Set(domains.filter(Boolean)));
  const uniqueNames = Array.from(new Set(subjectNames.filter(Boolean)));
  if (uniqueDomains.length === 0 && uniqueNames.length === 0) return { byEmail, byDomain, byName };

  const clauses: string[] = [];
  for (const d of uniqueDomains) clauses.push(`Website LIKE '%${escapeSoql(d)}%'`);
  for (const n of uniqueNames) clauses.push(`Name LIKE '%${escapeSoql(n)}%'`);
  type Rec = { Id: string; Name: string; Website: string | null };
  let records: Rec[] = [];
  try {
    records = await sfQuery<Rec>(
      `SELECT Id, Name, Website FROM Account WHERE ${clauses.join(" OR ")} LIMIT 400`,
    );
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_CONNECTED") return { byEmail, byDomain, byName };
    throw err;
  }
  const hits: AccountHit[] = records.map((r) => ({ accountId: r.Id, accountName: r.Name, website: r.Website }));

  for (const d of uniqueDomains) {
    // Exact host match beats "contains": enkon.com must not pick enkonsystems.com.
    const exact = hits.filter((h) => normalizeDomain(h.website) === d);
    const loose = hits.filter((h) => (normalizeDomain(h.website) ?? "").endsWith(`.${d}`));
    const pick = exact[0] ?? loose[0];
    if (pick) byDomain.set(d, pick);
  }
  for (const n of uniqueNames) {
    const ranked = rankAccounts({ kind: "name", name: n }, hits);
    if (ranked[0] && ranked[0].matchScore <= 2) byName.set(n, ranked[0]);
  }
  return { byEmail, byDomain, byName };
}

async function classify(thread: ThreadMessage[], accountName: string | null): Promise<Classification | null> {
  const client = getAnthropicClient();
  if (!client) return null;
  const response = await client.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 400,
    system: INBOX_CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: inboxClassifyPrompt(thread, accountName) }],
  });
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return parseClassification(text);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export type InboxRefreshSummary = {
  scanned: number;
  added: number;
  skippedAutomated: number;
  skippedInternal: number;
  alreadyKnown: number;
};

/**
 * Pull unread inbound mail, keep what looks like a person replying to or
 * introducing a deal, classify it, and add new threads to the table. Rows
 * already in the table are left alone (their draft and status belong to Seb).
 */
export async function refreshInbox(days = 14): Promise<InboxRefreshSummary> {
  const supabase = getSupabaseAdmin();
  const identities = await getMailboxIdentities();
  const myDomains = new Set(
    Array.from(identities)
      .map((address) => domainOf(address))
      .filter((d): d is string => Boolean(d)),
  );

  const messages = await fetchUnreadInbound(days);
  const summary: InboxRefreshSummary = { scanned: messages.length, added: 0, skippedAutomated: 0, skippedInternal: 0, alreadyKnown: 0 };

  // Latest inbound message per thread.
  const latestByConversation = new Map<string, GraphMessage>();
  for (const m of messages) {
    const email = (m.from?.emailAddress?.address ?? "").toLowerCase();
    const subject = m.subject ?? "";
    if (!email || isSelfAddress(email, identities)) { summary.skippedInternal++; continue; }
    const domain = domainOf(email);
    if (domain && myDomains.has(domain)) { summary.skippedInternal++; continue; }
    if (isAutomatedSender(email, subject) || m["@odata.type"] === "#microsoft.graph.eventMessage") {
      summary.skippedAutomated++;
      continue;
    }
    const existing = latestByConversation.get(m.conversationId);
    if (!existing || existing.receivedDateTime < m.receivedDateTime) latestByConversation.set(m.conversationId, m);
  }
  const candidates = Array.from(latestByConversation.values());
  if (candidates.length === 0) return summary;

  // Skip threads we already hold (by conversation), unless a newer message arrived.
  const { data: known } = await supabase
    .from("inbox_replies")
    .select("message_id, conversation_id, received_at")
    .in("conversation_id", candidates.map((c) => c.conversationId));
  const knownByConversation = new Map<string, { message_id: string; received_at: string }>();
  for (const k of known ?? []) knownByConversation.set(k.conversation_id, k);

  const fresh = candidates.filter((c) => {
    const k = knownByConversation.get(c.conversationId);
    if (!k) return true;
    if (k.message_id === c.id || k.received_at >= c.receivedDateTime) { summary.alreadyKnown++; return false; }
    return true; // newer inbound in a known thread: re-add under the new message
  });
  if (fresh.length === 0) return summary;

  // Account matching: by sender domain, then by company named in the subject.
  const emails = fresh.map((c) => (c.from?.emailAddress?.address ?? "").toLowerCase()).filter(Boolean);
  const domains = fresh.map((c) => domainOf(c.from?.emailAddress?.address)).filter((d): d is string => Boolean(d) && !isFreeMailDomain(d));
  const subjectNames = fresh.map((c) => companyFromSubject(c.subject)).filter((n): n is string => Boolean(n));
  const { byEmail, byDomain, byName } = await matchAccounts(emails, domains, subjectNames);

  const rows = await mapLimit(fresh, 4, async (m) => {
    const email = (m.from?.emailAddress?.address ?? "").toLowerCase();
    const domain = domainOf(email);
    let thread: ThreadMessage[] = [];
    try {
      const full = await fetchEmailThread(m.conversationId);
      thread = full.map((e) => ({
        from: e.from.name,
        email: e.from.email,
        at: e.receivedDateTime,
        mine: isSelfAddress(e.from.email, identities),
        text: trimReplyBody(e.bodyText || e.bodyPreview),
      }));
    } catch {
      thread = [{ from: m.from?.emailAddress?.name ?? "", email, at: m.receivedDateTime, mine: false, text: trimReplyBody(m.body?.content ?? m.bodyPreview ?? "") }];
    }
    if (thread.length === 0) {
      thread = [{ from: m.from?.emailAddress?.name ?? "", email, at: m.receivedDateTime, mine: false, text: trimReplyBody(m.body?.content ?? m.bodyPreview ?? "") }];
    }
    const hasMine = thread.some((t) => t.mine);

    let account: AccountHit | null = null;
    let matchedBy: "contact" | "domain" | "subject" | null = null;
    if (byEmail.has(email)) { account = byEmail.get(email)!; matchedBy = "contact"; }
    else if (domain && !isFreeMailDomain(domain) && byDomain.has(domain)) { account = byDomain.get(domain)!; matchedBy = "domain"; }
    else {
      const name = companyFromSubject(m.subject);
      if (name && byName.has(name)) { account = byName.get(name)!; matchedBy = "subject"; }
    }

    let classification: Classification | null = null;
    try {
      classification = await classify(thread, account?.accountName ?? null);
    } catch {
      classification = null;
    }
    const latest = thread[thread.length - 1];
    const sentiment = classification?.sentiment ?? null;
    const suggested = classification ? suggestedNextTouch(classification, m.receivedDateTime) : null;

    return {
      message_id: m.id,
      conversation_id: m.conversationId,
      subject: m.subject ?? null,
      from_name: m.from?.emailAddress?.name ?? null,
      from_email: email || null,
      from_domain: domain,
      received_at: m.receivedDateTime,
      preview: (latest?.text ?? m.bodyPreview ?? "").slice(0, 400),
      thread,
      has_mine: hasMine,
      account_id: account?.accountId ?? null,
      account_name: account?.accountName ?? null,
      account_matched_by: matchedBy,
      sentiment,
      timing_text: classification?.timingText ?? null,
      suggested_date: suggested,
      summary: classification?.summary ?? null,
      is_broker_intro: classification?.isBrokerIntro ?? false,
      status: "new" as InboxStatus,
      updated_at: new Date().toISOString(),
    };
  });

  // Replace older rows of the same thread so the list shows one card per thread.
  const staleIds = rows
    .map((r) => knownByConversation.get(r.conversation_id)?.message_id)
    .filter((id): id is string => Boolean(id));
  if (staleIds.length > 0) {
    await supabase.from("inbox_replies").delete().in("message_id", staleIds);
  }
  const { error } = await supabase.from("inbox_replies").upsert(rows, { onConflict: "message_id" });
  if (error) throw new Error(error.message);
  summary.added = rows.length;
  return summary;
}

export async function updateInboxRow(
  messageId: string,
  patch: Partial<Pick<InboxRow, "status" | "draft_body" | "suggested_date" | "sentiment" | "account_id" | "account_name" | "account_matched_by">>,
): Promise<InboxRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_replies")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("message_id", messageId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as InboxRow;
}

/** Re-run the classifier for one row (after Seb hits "Reclassify"). */
export async function reclassifyInboxRow(messageId: string): Promise<InboxRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("inbox_replies").select("*").eq("message_id", messageId).single();
  if (error) throw new Error(error.message);
  const row = data as InboxRow;
  if (!row.account_id && row.from_email) {
    const domain = domainOf(row.from_email);
    const name = companyFromSubject(row.subject);
    const { byEmail, byDomain, byName } = await matchAccounts([row.from_email], domain && !isFreeMailDomain(domain) ? [domain] : [], name ? [name] : []);
    const hit = byEmail.get(row.from_email.toLowerCase()) ?? (domain ? byDomain.get(domain) : undefined) ?? (name ? byName.get(name) : undefined);
    if (hit) {
      const matchedBy = byEmail.has(row.from_email.toLowerCase()) ? "contact" : domain && byDomain.has(domain) ? "domain" : "subject";
      await updateInboxRow(messageId, { account_id: hit.accountId, account_name: hit.accountName, account_matched_by: matchedBy });
      row.account_id = hit.accountId;
      row.account_name = hit.accountName;
      row.account_matched_by = matchedBy;
    }
  }
  const classification = await classify(row.thread, row.account_name);
  if (!classification) throw new Error("The classifier did not return a readable answer. Try again.");
  return updateInboxRow(messageId, {
    sentiment: classification.sentiment,
    suggested_date: suggestedNextTouch(classification, row.received_at),
  }).then(async (updated) => {
    await supabase
      .from("inbox_replies")
      .update({ timing_text: classification.timingText, summary: classification.summary, is_broker_intro: classification.isBrokerIntro })
      .eq("message_id", messageId);
    return { ...updated, timing_text: classification.timingText, summary: classification.summary, is_broker_intro: classification.isBrokerIntro };
  });
}

// ── Drafting ────────────────────────────────────────────────────────────────

type SentExample = { to: string; subject: string; body: string };
let sentExamplesCache: { at: number; items: SentExample[] } | null = null;

/** Short replies Seb sent recently, as voice examples. Cached for an hour. */
async function recentSentReplies(): Promise<SentExample[]> {
  if (sentExamplesCache && Date.now() - sentExamplesCache.at < 3_600_000) return sentExamplesCache.items;
  const credentials = await getMsValidCredentials();
  if (!credentials) return [];
  const params = new URLSearchParams({
    $select: "subject,toRecipients,body,sentDateTime",
    $orderby: "sentDateTime desc",
    $top: "60",
  });
  try {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?${params.toString()}`,
      { headers: { Authorization: `Bearer ${credentials.access_token}`, Prefer: 'outlook.body-content-type="text"' } },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as {
      value?: Array<{ subject?: string; toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>; body?: { content?: string } }>;
    };
    const items: SentExample[] = [];
    for (const m of data.value ?? []) {
      const subject = m.subject ?? "";
      if (!/^(re|aw|tr)\s*:/i.test(subject)) continue; // replies only
      const body = trimReplyBody(m.body?.content ?? "");
      if (body.length < 40 || body.length > 900) continue;
      const to = m.toRecipients?.[0]?.emailAddress?.name || m.toRecipients?.[0]?.emailAddress?.address || "";
      if (/blockit/i.test(to)) continue;
      items.push({ to, subject, body });
      if (items.length >= 8) break;
    }
    sentExamplesCache = { at: Date.now(), items };
    return items;
  } catch {
    return [];
  }
}

export type InboxDraft = { body: string; issues: string[]; source: "model" | "fallback" };

/** Write Seb's reply for one row and store it on the row. */
export async function draftInboxReply(messageId: string, nextTouchDate: string | null | undefined): Promise<{ item: InboxRow; draft: InboxDraft }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("inbox_replies").select("*").eq("message_id", messageId).single();
  if (error) throw new Error(error.message);
  const row = data as InboxRow;
  const sentiment = row.sentiment ?? "unclear";
  const firstName = firstNameOfSender(row.from_name, row.from_email);
  const theirs = row.thread[row.thread.length - 1]?.text ?? row.preview ?? "";
  const nextTouch = nextTouchDate === undefined ? row.suggested_date : nextTouchDate;

  let body: string | null = null;
  let source: InboxDraft["source"] = "model";
  const client = getAnthropicClient();
  if (sentiment === "positive" && !row.is_broker_intro) {
    // Seb's fixed structure; the model only contributes an optional detail sentence.
    let detail: string | null = null;
    if (client) {
      try {
        const response = await client.messages.create({
          model: DRAFT_MODEL,
          max_tokens: 120,
          system: POSITIVE_DETAIL_SYSTEM,
          messages: [{ role: "user", content: positiveDetailPrompt(row.thread) }],
        });
        const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().replace(/^"|"$/g, "");
        detail = text && text.length <= 220 && !/^(none|n\/a|empty|"")\.?$/i.test(text) ? text : null;
      } catch {
        detail = null;
      }
    }
    body = positiveDraft(firstName, detail);
  } else if (client) {
    const examples = await recentSentReplies();
    try {
      const response = await client.messages.create({
        model: DRAFT_MODEL,
        max_tokens: 500,
        system: INBOX_DRAFT_SYSTEM,
        messages: [{
          role: "user",
          content: inboxDraftPrompt({
            thread: row.thread,
            sentiment,
            isBrokerIntro: row.is_broker_intro,
            accountName: row.account_name,
            senderName: row.from_name,
            timingText: row.timing_text,
            nextTouchDate: nextTouch,
            examples,
          }),
        }],
      });
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      body = text ? normalizeDraft(text) : null;
    } catch {
      body = null;
    }
  }
  if (!body) {
    body = fallbackDraft(sentiment, firstName, row.timing_text);
    source = "fallback";
  }
  const issues = validateDraft(body, theirs.length);
  const item = await updateInboxRow(messageId, { draft_body: body, status: row.status === "new" ? "drafted" : row.status });
  return { item, draft: { body, issues, source } };
}

// ── Sending ─────────────────────────────────────────────────────────────────

export type SendOutcome = {
  item: InboxRow;
  recipients: Array<{ name: string | null; email: string }>;
  cc: string[];
  salesforce: { responded: RespondedOutcome | null; task: FollowUpOutcome | null; skipped: string | null };
};

async function setMessageRead(messageId: string, isRead: boolean): Promise<boolean> {
  const credentials = await getMsValidCredentials();
  if (!credentials) return false;
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${credentials.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ isRead }),
  }).catch(() => null);
  return !!response && response.ok;
}

async function markMessageRead(messageId: string): Promise<void> {
  await setMessageRead(messageId, true);
}

/**
 * "I'll deal with this one myself in Outlook": flip the message back to
 * unread there and take it out of the tool's pile (status skipped). Nothing
 * is sent and Salesforce is not touched.
 */
export async function markInboxUnread(messageId: string): Promise<InboxRow> {
  const ok = await setMessageRead(messageId, false);
  if (!ok) throw new Error("Could not mark the message unread in Outlook. Check the Outlook connection and try again.");
  return updateInboxRow(messageId, { status: "skipped" });
}

/**
 * Send the reply into the thread, then update Salesforce for account threads:
 * Responded + response type, and the RCE task when `rceDays` is a number.
 * Broker intros and unmatched senders only get the email.
 */
export async function sendInboxReply(params: {
  messageId: string;
  body: string;
  rceDays: number | null;
  sentiment?: Sentiment;
}): Promise<SendOutcome> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("inbox_replies").select("*").eq("message_id", params.messageId).single();
  if (error) throw new Error(error.message);
  const row = data as InboxRow;
  if (row.status === "sent") throw new Error("This reply was already sent.");
  const body = params.body.trim();
  if (!body) throw new Error("The reply is empty.");
  const sentiment: Sentiment = params.sentiment ?? row.sentiment ?? "unclear";
  if (!row.from_email) throw new Error("The sender has no email address.");

  // 1. Outlook: reply all in-thread (their CCs stay on), Blockit copied on a positive.
  const identities = await getMailboxIdentities();
  const cc = sentiment === "positive" && !row.is_broker_intro ? [BLOCKIT_CC] : [];
  const draft = await createOutlookReplyAllDraft(row.message_id, body, {
    selfAddresses: identities,
    sender: { name: row.from_name, email: row.from_email },
    extraCc: cc,
  });
  const recipients = draft.recipients ?? [];
  if (recipients.length === 0 || recipients.every((r) => isSelfAddress(r.email, identities))) {
    await deleteOutlookDraftIfUnsent(draft.id).catch(() => undefined);
    throw new Error("The reply came out addressed to you, not the sender. Nothing was sent.");
  }
  try {
    await sendOutlookDraft(draft.id);
  } catch (err) {
    await deleteOutlookDraftIfUnsent(draft.id).catch(() => undefined);
    throw err;
  }
  await markMessageRead(row.message_id);
  const sentAt = new Date().toISOString();

  // 2. Salesforce, account threads only.
  const salesforce: SendOutcome["salesforce"] = { responded: null, task: null, skipped: null };
  let taskId: string | null = null;
  let taskDate: string | null = null;
  let sfRespondedAt: string | null = null;
  if (!row.account_id || row.is_broker_intro) {
    salesforce.skipped = row.is_broker_intro ? "broker intro" : "no Salesforce account";
  } else {
    try {
      salesforce.responded = await markAccountResponded(row.account_id, sentiment);
      sfRespondedAt = sentAt;
    } catch (err) {
      salesforce.skipped = `account update failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
    if (params.rceDays && params.rceDays > 0) {
      try {
        salesforce.task = await scheduleRceTask(row.account_id, sentAt, params.rceDays);
        taskId = salesforce.task.taskId;
        taskDate = salesforce.task.date;
      } catch (err) {
        salesforce.skipped = `${salesforce.skipped ? salesforce.skipped + "; " : ""}task failed: ${err instanceof Error ? err.message : "unknown error"}`;
      }
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("inbox_replies")
    .update({
      status: "sent",
      draft_body: body,
      sentiment,
      sent_at: sentAt,
      sf_responded_at: sfRespondedAt,
      task_id: taskId,
      task_date: taskDate,
      suggested_date: params.rceDays ? addDays(sentAt, params.rceDays) : null,
      updated_at: sentAt,
    })
    .eq("message_id", params.messageId)
    .select("*")
    .single();
  if (updateError) throw new Error(updateError.message);
  return { item: updated as InboxRow, recipients, cc: draft.cc, salesforce };
}
