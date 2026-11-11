/**
 * Inbox: classification of inbound replies to outreach.
 *
 * Pure helpers (no network) so the rules can be unit-tested: which senders
 * are noise, how a reply's sentiment maps to a next-touch date, and how the
 * model's answer is parsed defensively.
 */

export type Sentiment = "positive" | "neutral" | "negative" | "unclear";

/**
 * What Seb's reply should do, separate from the sentiment (which only feeds
 * Salesforce's response type). Nov 2026: one label used to decide the reply,
 * the scheduling-bot CC and the RCE date all at once, so "Friday works" got a
 * bot invite and "I'll send the data end of week" got "I'll check back in May".
 *   book_call    they will talk, no time named: scheduling sentence + bot CC
 *   accept_time  they named a time, or confirm one already set: confirm it, no bot
 *   acknowledge  they sent or promised something, or a plain update: short thank-you
 *   check_back   deferral or no: close the loop, RCE on their timing
 *   none         an automatic reply (out of office, left the company): no reply
 */
export type ReplyType = "book_call" | "accept_time" | "acknowledge" | "check_back" | "none";
export const REPLY_TYPES: ReplyType[] = ["book_call", "accept_time", "acknowledge", "check_back"];
export const REPLY_TYPE_LABEL: Record<ReplyType, string> = {
  book_call: "Book a call",
  accept_time: "Accept their time",
  acknowledge: "Acknowledge",
  check_back: "Check back later",
  none: "No reply needed",
};
export type AutoReply = "out_of_office" | "left_company" | null;

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
  /** What the reply should do. */
  replyType: ReplyType;
  /** An automatic reply: out of office, or the person has left the company. */
  autoReply: AutoReply;
  /** Out of office: the day they are back (YYYY-MM-DD), when stated. */
  returnDate: string | null;
  /** Left the company / away: who to write to instead, as given ("Jane Doe, jane@x.com"). */
  newContact: string | null;
};

/** Reply type for rows classified before reply types existed. */
export function fallbackReplyType(sentiment: Sentiment | null, isBrokerIntro: boolean): ReplyType {
  if (isBrokerIntro) return "acknowledge";
  if (sentiment === "positive") return "book_call";
  if (sentiment === "neutral" || sentiment === "negative") return "check_back";
  return "acknowledge";
}

/**
 * Defaults when a reply type is picked: CC the scheduling bot only to book a
 * call; an RCE only for "check back later" (their timing, else 6 months, a
 * year after a no).
 */
export function replyDefaults(
  type: ReplyType,
  row: { sentiment: Sentiment | null; suggested_date: string | null; received_at: string; is_broker_intro: boolean },
  today: string,
): { cc: boolean; rceDays: number | null } {
  if (type === "book_call") return { cc: !row.is_broker_intro, rceDays: null };
  if (type !== "check_back") return { cc: false, rceDays: null };
  if (row.suggested_date && row.suggested_date > today) return { cc: false, rceDays: Math.max(1, daysBetweenDates(today, row.suggested_date)) };
  return { cc: false, rceDays: row.sentiment === "negative" ? DEFAULT_NEXT_TOUCH_DAYS.negative! : DEFAULT_NEXT_TOUCH_DAYS.neutral! };
}

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
  // Bulk-mail subdomains: global@email.datasite.com, news@mail.x.com, etc.
  if (/^(email|e|mail|mailer|news|newsletter|marketing|info|go|em|send|updates?)\./.test(domain)) return true;
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
  // A date in a positive reply is usually the meeting itself, not a reconnect.
  if (c.sentiment === "positive") return null;
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

replyType, what Seb's reply should do:
- "book_call": they agree to talk or ask for a call, but name no specific day or time. Seb's scheduling tool will send times.
- "accept_time": they propose a specific day or time ("tomorrow at 4:30", "Friday works"), or confirm a call that is already set. Seb just confirms.
- "acknowledge": they sent something (financials, a deck, a CIM), promise to send something ("I'll send the data end of week"), answer a question, or give an update that needs only a short thank-you. Also broker emails sharing materials.
- "check_back": a deferral, "not now", "not selling", or a no. Seb closes the loop and reconnects later.
- "none": an automatic reply (out of office, the person has left the company). No reply is needed.

autoReply: "out_of_office" for an automatic away or vacation reply, "left_company" when the reply says the person no longer works there, otherwise null. returnDate: for out of office, the day they are back (YYYY-MM-DD) if stated, else null. newContact: the person or address they point to instead ("Jane Doe, jane@acme.com", "contact@acme.com"), copied as written, else null.

summary: one short sentence in plain words saying what they said, e.g. "Not selling, suggests reconnecting in six months."

Return exactly: {"sentiment":"positive|neutral|negative|unclear","timingText":string|null,"timingDate":"YYYY-MM-DD"|null,"summary":string,"isBrokerIntro":boolean,"replyType":"book_call|accept_time|acknowledge|check_back|none","autoReply":"out_of_office"|"left_company"|null,"returnDate":"YYYY-MM-DD"|null,"newContact":string|null}`;

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
  const isBrokerIntro = parsed.isBrokerIntro === true;
  const autoRaw = String(parsed.autoReply ?? "").toLowerCase();
  const autoReply: AutoReply = autoRaw === "out_of_office" || autoRaw === "left_company" ? autoRaw : null;
  const typeRaw = String(parsed.replyType ?? "").toLowerCase();
  const replyType: ReplyType = autoReply
    ? "none"
    : (["book_call", "accept_time", "acknowledge", "check_back"] as string[]).includes(typeRaw)
      ? (typeRaw as ReplyType)
      : fallbackReplyType(sentiment, isBrokerIntro);
  const returnDate = autoReply === "out_of_office" && typeof parsed.returnDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.returnDate) ? parsed.returnDate : null;
  const newContact = autoReply && typeof parsed.newContact === "string" && parsed.newContact.trim() ? parsed.newContact.trim().slice(0, 200) : null;
  return {
    sentiment,
    timingText: typeof parsed.timingText === "string" && parsed.timingText.trim() ? parsed.timingText.trim() : null,
    timingDate,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 240) : "",
    isBrokerIntro,
    replyType,
    autoReply,
    returnDate,
    newContact,
  };
}

/** Strip quoted history, signatures, tracking links and legal footers so the
 * sheet shows just what they wrote. */
export function trimReplyBody(text: string): string {
  const lines = (text ?? "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let afterSignOff = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");
    const t = line.trim();
    if (/^(from|de|von)\s*:\s*.+/i.test(t) && out.length > 0) break;
    if (/^on .+ wrote:$/i.test(t)) break;
    if (/^-{3,}\s*original message\s*-{3,}$/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break;
    if (/^(important|confidential|confidentiality|disclaimer|notice|caution|warning)\s*:/i.test(t)) break;
    if (/^(this (e-?mail|message)|the (contents|information) (of|in|contained))/i.test(t) && /confiden|intended|recipient|privileged/i.test(t)) break;
    if (t.startsWith(">")) continue;
    if (/^\[(icon|photo|image|cid|logo)[^\]]*\]/i.test(t)) continue;
    if (/urldefense\.proofpoint\.com|safelinks\.protection\.outlook\.com/i.test(t)) continue;
    if (/^<?(https?:\/\/|mailto:|tel:)/i.test(t)) continue;
    if (afterSignOff > 0) {
      // Sign-off seen: keep the name line, then stop at the signature block.
      if (!t) continue;
      if (afterSignOff === 1) { out.push(line); afterSignOff = 2; continue; }
      break;
    }
    out.push(line);
    if (/^(regards|best|best regards|kind regards|warm regards|thank you|thanks|many thanks|cheers|sincerely|all the best|take care|talk soon|br)[,.!]?$/i.test(t)) {
      afterSignOff = 1;
    }
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  // Collapse runs of blank lines.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** "rce50", "RCE 50", "50" → 50. Blank or "none" → null. Anything else → undefined (invalid). */
export function parseRceDays(input: string): number | null | undefined {
  const t = (input ?? "").trim().toLowerCase();
  if (!t || t === "none" || t === "no" || t === "-" || t === "0") return null;
  const m = t.match(/^(?:rce\s*)?(\d{1,4})$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n <= 1500 ? n : undefined;
}

export function daysBetweenDates(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${toIso.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}
