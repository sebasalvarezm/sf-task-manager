import { getSupabaseAdmin } from "./supabase";
import { fetchContactsForAccounts } from "./salesforce-contacts";
import { getMailboxIdentities, isSelfAddress, listSentMessagesSince, type SentMessage } from "./microsoft";
import type { WeeklyOutreachItem, WeeklyOutreachSourceMetadata } from "./weekly-outreach";

/**
 * When Seb sends a reconnect himself (the tool picked the wrong Outlook chain
 * and he replied in the right one), find that email in his Sent Items and
 * link the Weekly Outreach row to its chain, so the follow-up goes into the
 * right conversation without him looking it up again. The chain is also
 * remembered for the account, so the next reconnect starts there.
 *
 * Read only on Outlook: nothing is sent or changed there.
 */

export const MANUAL_SEND_WINDOW_DAYS = 7;
const OVERRIDES_KEY = "rce_thread_overrides";
const PUBLIC_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com"]);

export function domainFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The email Seb sent to this company most recently within the window: to an
 * address on its domain, one of its Salesforce contacts, or someone already on
 * the row. Replies ("RE:") beat new emails, then the newest wins. Pure.
 */
export function pickManualSend(
  sent: SentMessage[],
  opts: { domain: string | null; contactEmails: Iterable<string>; since: string; identities: Set<string> },
): SentMessage | null {
  const domain = opts.domain && !PUBLIC_DOMAINS.has(opts.domain) ? opts.domain : null;
  const contacts = new Set(Array.from(opts.contactEmails).map((e) => e.toLowerCase()).filter(Boolean));
  const since = Date.parse(opts.since);
  const forCompany = (email: string) => {
    if (isSelfAddress(email, opts.identities)) return false;
    if (contacts.has(email)) return true;
    const host = email.split("@")[1] ?? "";
    return !!domain && (host === domain || host.endsWith(`.${domain}`));
  };
  const hits = sent.filter((m) => Date.parse(m.sentDateTime) >= since && [...m.to, ...m.cc].some((r) => forCompany(r.email)));
  if (hits.length === 0) return null;
  const isReply = (m: SentMessage) => /^\s*re\s*:/i.test(m.subject);
  hits.sort((a, b) => Number(isReply(b)) - Number(isReply(a)) || Date.parse(b.sentDateTime) - Date.parse(a.sentDateTime));
  return hits[0];
}

/** Put the found email on the row: its chain, who it went to, when. Pure. */
export function linkToManualSend(metadata: WeeklyOutreachSourceMetadata, found: SentMessage, identities: Set<string>): { metadata: WeeklyOutreachSourceMetadata; relinked: boolean; note: string } {
  const relinked = !!metadata.conversationId && metadata.conversationId !== found.conversationId;
  const to = found.to.filter((r) => !isSelfAddress(r.email, identities));
  const who = to.map((r) => r.name || r.email).join(", ");
  const when = new Date(found.sentDateTime).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto" });
  const note = `Linked to the chain you sent in: "${found.subject}" (${when}, to ${who || "the company"}). The follow-up goes there.`;
  return {
    relinked,
    note,
    metadata: {
      ...metadata,
      conversationId: found.conversationId,
      replyToMessageId: found.id,
      replySubject: found.subject,
      replyReason: note,
      rceFirstSentAt: found.sentDateTime,
      recipients: to.length ? to : metadata.recipients,
      manualSentAt: metadata.manualSentAt ?? new Date().toISOString(),
    },
  };
}

/** Look in Sent Items for Seb's own email to this company. Read only. */
export async function findManualSend(item: Pick<WeeklyOutreachItem, "sf_account_id" | "website">, metadata: WeeklyOutreachSourceMetadata, now = new Date()): Promise<{ found: SentMessage | null; identities: Set<string>; domain: string | null }> {
  const anchor = metadata.manualSentAt ? Date.parse(metadata.manualSentAt) : now.getTime();
  const since = new Date(Math.min(anchor, now.getTime()) - MANUAL_SEND_WINDOW_DAYS * 86_400_000).toISOString();
  const domain = domainFromWebsite(item.website);
  const [sent, identities, contacts] = await Promise.all([
    listSentMessagesSince(since),
    getMailboxIdentities().catch(() => new Set<string>()),
    item.sf_account_id
      ? fetchContactsForAccounts([item.sf_account_id]).then((m) => (m.get(item.sf_account_id!) ?? []).map((c) => (c.Email ?? "").toLowerCase()).filter(Boolean)).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);
  const contactEmails = [...contacts, ...metadata.recipients.map((r) => r.email)];
  return { found: pickManualSend(sent, { domain, contactEmails, since, identities }), identities, domain };
}

// ── The chain to start from next time, per account ──────────────────────────

export type ThreadOverride = { conversationId: string; subject: string; at: string };

export async function getThreadOverride(accountId: string | null | undefined): Promise<ThreadOverride | null> {
  if (!accountId) return null;
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", OVERRIDES_KEY).maybeSingle();
  return ((data?.value as Record<string, ThreadOverride> | undefined) ?? {})[accountId] ?? null;
}

/** Remember the chain Seb chose for this account. Best effort, never throws. */
export async function saveThreadOverride(accountId: string | null | undefined, found: SentMessage): Promise<void> {
  if (!accountId || !found.conversationId) return;
  try {
    const supabase = getSupabaseAdmin();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data } = await supabase.from("app_settings").select("value, updated_at").eq("key", OVERRIDES_KEY).maybeSingle();
      const value = { ...((data?.value as Record<string, ThreadOverride> | undefined) ?? {}), [accountId]: { conversationId: found.conversationId, subject: found.subject, at: found.sentDateTime } };
      if (!data) {
        const { error } = await supabase.from("app_settings").insert({ key: OVERRIDES_KEY, value });
        if (!error) return;
        continue;
      }
      const { data: hit } = await supabase.from("app_settings").update({ value, updated_at: new Date().toISOString() }).eq("key", OVERRIDES_KEY).eq("updated_at", data.updated_at as string).select("key");
      if (hit && hit.length === 1) return;
    }
  } catch {
    /* the row is still linked; only the memory for next time is skipped */
  }
}
