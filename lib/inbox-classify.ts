/**
 * Inbox: classification of inbound replies to outreach.
 *
 * Pure helpers (no network) so the rules can be unit-tested: which senders
 * are noise, how a reply's sentiment maps to a next-touch date, and how the
 * model's answer is parsed defensively.
 */

export type Sentiment = "positive" | "neutral" | "negative" | "unclear";

export type ThreadMessage = {
  from: string;
  email: string;
  at: string;
  mine: boolean;
  text: string;
};

export type Classification = {
  sentiment: Sentiment;
  /** Their words about timing, verbatim ("six months or so"), or null. */
  timingText: string | null;
  /** Concrete date derived from timingText, or null when they gave none. */
  timingDate: string | null;
  /** One line, in plain words, what they said. */
  summary: string;
  /** A broker or intermediary introducing a business, not a reply to our outreach. */
  isBrokerIntro: boolean;
};

/** Senders that are never a human reply to outreach. */
const AUTOMATED_LOCAL_PARTS = /^(no-?reply|noreply|notifications?|notification|mailer-daemon|postmaster|donotreply|do-not-reply|bounce|alerts?|support|newsletter|news|marketing|info|hello|team|digest|billing|security|calendar)([.+-].*)?$/i;
const AUTOMATED_DOMAINS = [
  "salesforce.com",
  "proofpoint.com",
  "pphosted.com",
  "linkedin.com",
  "microsoft.com",
  "microsoftonline.com",
  "office365.com",
  "google.com",
  "zoom.us",
  "docusign.net",
  "docusign.com",
  "blockit.com",
  "blockit.ai",
  "calendly.com",
];
const CALENDAR_SUBJECT = /^(accepted|declined|tentative|tentatively accepted|invitation|updated invitation|canceled|cancelled|new time proposed)\s*:/i;

export function isAutomatedSender(email: string, subject: string): boolean {
  const address = (email ?? "").toLowerCase().trim();
  if (!address.includes("@")) return true;
  const [local, domain] = address.split("@");
  if (AUTOMATED_LOCAL_PARTS.test(local)) return true;
  if (AUTOMATED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  if (CALENDAR_SUBJECT.test(subject ?? "")) return true;
  return false;
}

export function domainOf(email: string | null | undefined): string | null {
  const address = (email ?? "").toLowerCase().trim();
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).replace(/^www\./, "");
  return domain || null;
}

/** Free-mail domains never identify a company. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "yahoo.ca", "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me",
  "msn.com", "videotron.ca", "sympatico.ca", "bell.net", "rogers.com", "shaw.ca", "telus.net",
]);
export function isFreeMailDomain(domain: string | null): boolean {
  return !domain || FREE_MAIL.has(domain);
}

/** "Valstone & Enkon" / "Valstone / Enkon" / "Enkon & Valstone" → "Enkon". */
export function companyFromSubject(subject: string | null | undefined): string | null {
  const cleaned = (subject ?? "").replace(/^(re|fw|fwd|aw|tr)\s*:\s*/gi, "").trim();
  const m =
    cleaned.match(/^valstone\s*(?:&|\/|and|x|-)\s*(.+)$/i) ??
    cleaned.match(/^(.+?)\s*(?:&|\/|and|x|-)\s*valstone$/i);
  if (!m) return null;
  const name = m[1].replace(/[:\-–—].*$/, "").trim();
  return name.length >= 2 ? name : null;
}

/** Days until the next touch when they gave no date. */
export const DEFAULT_NEXT_TOUCH_DAYS: Record<Sentiment, number | null> = {
  positive: null, // the call is the next step
  neutral: 182,
  negative: 365,
  unclear: null,
};

export function addDays(fromIso: string, days: number): string {
  const d = new Date(fromIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Date the module proposes for the RCE task, or null when none should be set. */
export function suggestedNextTouch(c: Pick<Classification, "sentiment" | "timingDate">, receivedAt: string): string | null {
  if (c.sentiment === "negative") return addDays(receivedAt, DEFAULT_NEXT_TOUCH_DAYS.negative!);
  if (c.timingDate && /^\d{4}-\d{2}-\d{2}$/.test(c.timingDate)) {
    // Never schedule in the past; "next year" said in December is still ahead.
    return c.timingDate > receivedAt.slice(0, 10) ? c.timingDate : addDays(receivedAt, 30);
  }
  const days = DEFAULT_NEXT_TOUCH_DAYS[c.sentiment];
  return days === null ? null : addDays(receivedAt, days);
}

export const INBOX_CLASSIFY_SYSTEM = `You read replies to acquisition outreach sent by Sebastian (Seb) Alvarez of Valstone, a permanent-capital acquirer of vertical market software companies. Classify the latest inbound message in the thread. Answer with JSON only.

Sentiment:
- "positive": they are willing to speak, ask for a call, ask for more information, or say yes to a meeting.
- "neutral": polite deferral or no interest without hostility ("not considering selling", "not at this time", "touch base in six months", "we'll keep you in mind", "send me something to read").
- "negative": they ask not to be contacted again, say stop, unsubscribe, remove me, or are hostile.
- "unclear": none of the above fits (out of office, a question with no stance, an intermediary's intro).

Timing: if they name when to reconnect ("six months or so", "Q1", "next year", "after the summer", "in 2027"), copy their words into timingText and turn it into one concrete date in timingDate (YYYY-MM-DD). Use the message date as "now". "Six months or so" = 6 months after the message date. "Q1" = the first business day of the next Q1. "Next year" = January 15 of next year. "After the summer" = September 15. If they gave no timing, both are null.

isBrokerIntro: true when the sender is a broker, banker or intermediary introducing a business for sale (not the company owner replying to our outreach).

summary: one short sentence in plain words saying what they said, e.g. "Not selling, suggests reconnecting in six months."

Return exactly: {"sentiment":"positive|neutral|negative|unclear","timingText":string|null,"timingDate":"YYYY-MM-DD"|null,"summary":string,"isBrokerIntro":boolean}`;

export function inboxClassifyPrompt(thread: ThreadMessage[], accountName: string | null): string {
  const lines = thread.slice(-4).map((m) => {
    const who = m.mine ? "SEB (Valstone)" : `${m.from || m.email} <${m.email}>`;
    return `--- ${who} on ${m.at.slice(0, 10)} ---\n${m.text.trim().slice(0, 2500)}`;
  });
  return [
    accountName ? `Salesforce account: ${accountName}` : "Salesforce account: not matched",
    `Message date (treat as now): ${thread[thread.length - 1]?.at.slice(0, 10) ?? ""}`,
    "",
    "Thread, oldest first. Classify the LAST message:",
    "",
    ...lines,
  ].join("\n");
}

export function parseClassification(raw: string): Classification | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sentimentRaw = String(parsed.sentiment ?? "").toLowerCase();
  const sentiment: Sentiment = (["positive", "neutral", "negative", "unclear"] as const).includes(
    sentimentRaw as Sentiment,
  )
    ? (sentimentRaw as Sentiment)
    : "unclear";
  const timingDate =
    typeof parsed.timingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.timingDate)
      ? parsed.timingDate
      : null;
  return {
    sentiment,
    timingText: typeof parsed.timingText === "string" && parsed.timingText.trim() ? parsed.timingText.trim() : null,
    timingDate,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 240) : "",
    isBrokerIntro: parsed.isBrokerIntro === true,
  };
}

/** Strip quoted history and signatures so the sheet shows just what they wrote. */
export function trimReplyBody(text: string): string {
  const lines = (text ?? "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(from|de|von)\s*:\s*.+/i.test(t) && out.length > 0) break;
    if (/^on .+ wrote:$/i.test(t)) break;
    if (/^-{3,}\s*original message\s*-{3,}$/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  // Drop trailing blank lines.
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n").trim();
}
