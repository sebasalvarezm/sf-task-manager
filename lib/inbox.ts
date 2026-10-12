import { getMsValidCredentials, fetchEmailThread, getMailboxIdentities, isSelfAddress } from "./microsoft";
import { sfQuery } from "./sf-query";
import { getSupabaseAdmin } from "./supabase";
import { getAnthropicClient } from "./anthropic";
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
  trimReplyBody,
  type Classification,
  type Sentiment,
  type ThreadMessage,
} from "./inbox-classify";

/**
 * Inbox: inbound replies to outreach, one row per thread (its latest inbound
 * message), classified and matched to a Salesforce account.
 *
 * Phase 1 is read-only: nothing here writes to Salesforce or sends mail.
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
  account_matched_by: "domain" | "subject" | null;
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

const CLASSIFY_MODEL = "claude-sonnet-4-6";

export async function listInbox(): Promise<InboxRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_replies")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as InboxRow[];
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

/** Match sender domains and subject-named companies to Salesforce accounts in one pass. */
async function matchAccounts(
  domains: string[],
  subjectNames: string[],
): Promise<{ byDomain: Map<string, AccountHit>; byName: Map<string, AccountHit> }> {
  const byDomain = new Map<string, AccountHit>();
  const byName = new Map<string, AccountHit>();
  const uniqueDomains = Array.from(new Set(domains.filter(Boolean)));
  const uniqueNames = Array.from(new Set(subjectNames.filter(Boolean)));
  if (uniqueDomains.length === 0 && uniqueNames.length === 0) return { byDomain, byName };

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
    if (err instanceof Error && err.message === "NOT_CONNECTED") return { byDomain, byName };
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
  return { byDomain, byName };
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
  const domains = fresh.map((c) => domainOf(c.from?.emailAddress?.address)).filter((d): d is string => Boolean(d) && !isFreeMailDomain(d));
  const subjectNames = fresh.map((c) => companyFromSubject(c.subject)).filter((n): n is string => Boolean(n));
  const { byDomain, byName } = await matchAccounts(domains, subjectNames);

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
    let matchedBy: "domain" | "subject" | null = null;
    if (domain && !isFreeMailDomain(domain) && byDomain.has(domain)) { account = byDomain.get(domain)!; matchedBy = "domain"; }
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
