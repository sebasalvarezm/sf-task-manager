import type { OutlookRelationshipEmail } from "./microsoft";

/**
 * Picking the Outlook chain to reply to.
 *
 * The mailbox search behind this is a plain full-text search, so it also returns
 * threads that merely mention the company somewhere in a body or an attachment.
 * Replying into one of those would drop an M&A reconnect into an unrelated chain,
 * so candidate threads are scored on evidence instead of "most recent wins".
 */

export type RceThreadConfidence = "domain" | "subject" | "none";

export type RceThreadMatch = {
  /** The message to reply to, or null when nothing scored high enough. */
  replyTarget: OutlookRelationshipEmail | null;
  confidence: RceThreadConfidence;
  /** Short plain-English explanation shown under the subject in the review box. */
  reason: string;
};

const DOMAIN_PARTICIPANT = 100;
const NAME_IN_SUBJECT = 50;
const USER_REPLIED = 25;
const NAME_IN_BODY_ONLY = 5;
/** Below this a thread is only a stray body mention, so it is not worth replying into. */
const CONFIDENCE_FLOOR = 40;

const LEGAL_SUFFIXES = new Set([
  "inc", "inc.", "llc", "l.l.c.", "ltd", "ltd.", "limited", "corp", "corp.",
  "corporation", "co", "co.", "company", "gmbh", "sa", "s.a.", "sas", "bv", "nv",
  "plc", "pty", "ag", "srl", "spa", "ab", "as", "oy", "group", "holdings",
  "holding", "international", "industries", "enterprises", "technologies", "tech",
  "solutions", "services", "systems", "the", "and", "&",
]);

/** Free email hosts never identify a company, so they must not count as a domain match. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "live.com", "aol.com",
  "icloud.com", "me.com", "msn.com", "protonmail.com", "proton.me", "gmx.com",
  "yandex.com", "mail.com", "zoho.com",
]);

function domainOf(email: string): string {
  return email.toLowerCase().split("@")[1] ?? "";
}

/**
 * The distinctive words in a company name, with legal boilerplate removed.
 * "Sentry Water Tech Inc." -> ["sentry", "water"]
 */
function distinctiveNameTokens(accountName: string): string[] {
  return accountName
    .toLowerCase()
    .replace(/[^a-z0-9\s&.-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !LEGAL_SUFFIXES.has(token));
}

function containsWholeWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * True when enough of the company name shows up as whole words in the text.
 *
 * The leading word is the brand ("Sentry" in "Sentry Water Tech"), and brokers
 * routinely shorten to it, so a hit there is enough. Otherwise two words must
 * match, which stops a lone generic word like "water" carrying a match by itself.
 */
function mentionsCompany(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  if (containsWholeWord(text, tokens[0])) return true;
  return tokens.filter((token) => containsWholeWord(text, token)).length >= 2;
}

/**
 * Chooses which Outlook chain an RCE reconnect should reply to.
 *
 * Direct threads win on the company's email domain. Broker threads have no domain
 * hit, so they win on the company name in the subject plus a reply from the user.
 * Threads that only mention the company deep in a body fall below the floor and
 * are rejected, leaving the chain to be chosen by hand.
 */
export function matchRceReplyThread(
  emails: OutlookRelationshipEmail[],
  accountName: string,
  companyDomain: string | null,
  mailboxAddress: string,
): RceThreadMatch {
  const mailbox = mailboxAddress.toLowerCase();
  const domain = companyDomain?.toLowerCase() ?? "";
  const useDomain = Boolean(domain) && !PUBLIC_EMAIL_DOMAINS.has(domain);
  const tokens = distinctiveNameTokens(accountName);

  const threads = new Map<string, OutlookRelationshipEmail[]>();
  for (const email of emails) {
    // Fall back to the message id so a message with no conversation still competes.
    const key = email.conversationId || email.id;
    const existing = threads.get(key);
    if (existing) existing.push(email);
    else threads.set(key, [email]);
  }

  let best: { score: number; confidence: RceThreadConfidence; reason: string; target: OutlookRelationshipEmail } | null = null;

  for (const messages of threads.values()) {
    // Only a message the user received can be replied to in the original chain.
    const received = messages
      .filter((message) => message.fromEmail && message.fromEmail !== mailbox)
      .sort((a, b) => new Date(a.sentDateTime).getTime() - new Date(b.sentDateTime).getTime());
    const target = received[received.length - 1];
    if (!target) continue;

    const participants = messages.flatMap((message) => [message.fromEmail, ...message.toEmails]);
    const domainParticipant = useDomain
      ? participants.find((address) => address && domainOf(address).endsWith(domain))
      : undefined;
    const subjectHit = messages.some((message) => mentionsCompany(message.subject, tokens));
    const userReplied = messages.some((message) => message.fromEmail === mailbox);

    let score = 0;
    if (domainParticipant) score += DOMAIN_PARTICIPANT;
    if (subjectHit) score += NAME_IN_SUBJECT;
    if (userReplied) score += USER_REPLIED;
    if (!domainParticipant && !subjectHit) score += NAME_IN_BODY_ONLY;
    // Recency only separates threads that are otherwise equally well evidenced.
    const ageDays = (Date.now() - new Date(target.sentDateTime).getTime()) / 86_400_000;
    score += Math.max(0, 5 - ageDays / 365);

    const confidence: RceThreadConfidence = domainParticipant
      ? "domain"
      : subjectHit
        ? "subject"
        : "none";
    const reason = domainParticipant
      ? `${domainParticipant} is on this thread`
      : subjectHit
        ? `${accountName} is named in the subject, but nobody from their domain is on the thread. Check the chain before sending.`
        : "";

    if (!best || score > best.score) best = { score, confidence, reason, target };
  }

  if (!best || best.score < CONFIDENCE_FLOOR) {
    return {
      replyTarget: null,
      confidence: "none",
      reason: useDomain
        ? `No Outlook thread involves ${domain} or names ${accountName} in a subject. Choose the chain manually.`
        : `No Outlook thread names ${accountName} in a subject. Choose the chain manually.`,
    };
  }

  return { replyTarget: best.target, confidence: best.confidence, reason: best.reason };
}
