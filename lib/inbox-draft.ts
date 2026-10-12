import type { Sentiment, ThreadMessage } from "./inbox-classify";

/**
 * Inbox: drafting Seb's reply to an inbound message. Pure prompt builders and
 * validators; the network calls live in lib/inbox.ts.
 */

export const BLOCKIT_CC = "bot@blockit.com";

export const INBOX_DRAFT_SYSTEM = `You write email replies as Sebastian (Seb) Alvarez, Director of M&A at Valstone, a permanent-capital acquirer of vertical market software companies. The reply goes into an existing thread, so never restate what they said and never repeat what they already know.

Voice: a smart operator typing quickly. Direct, natural, warm without being soft, confident without being salesy. Principal speaking to a principal. Simple sentences, one idea each. Short paragraphs. Natural contractions (I'll, we'd, don't). Plain words: acquisition, owner, call, next steps.

Hard rules:
- Never use an em dash or en dash. Use commas, full stops or parentheses.
- Write "thank you", never "thanks".
- Never use: circle back, touch base, synergies, strategic alignment, unlock value, explore potential opportunities, leverage, at your earliest convenience, I hope this email finds you well, we would be delighted, please do not hesitate, kindly, bump, I know you are busy, just wanted to make sure you saw this, looking forward to hearing from you, thank you in advance, feel free to reach out, squarely.
- No generic compliments, no stacked adjectives, no "very", no consultant or banker language, nothing that reads as written by AI.
- Greeting: "Hi <first name>," using the sender's first name. Closing: "Best," then "Sebastian" on its own line (or "Thank you," then "Seb" when the thread is already casual and first-name).
- Length: shorter than their message. Two to four sentences in the body is the norm.
- Output the email body only: greeting, body, closing. No subject line, no commentary, no quotes around it.

By reply type:
- POSITIVE (they will speak): appreciate the reply and the willingness to speak, say that a Teams invite with a few times will follow from my scheduling assistant, who is copied. Do not propose times yourself. If they named a city and date to meet in person, confirm it plainly.
- NEUTRAL (deferral or not now): acknowledge without arguing, close the loop, and name the next touch plainly using the timing given ("I'll check back in the spring", "I'll reach out again in Q2"). If no timing was given, "I'll check back in a few months". Optional one short genuine positive note if the thread earns it. Never longer than their email.
- NEGATIVE (stop, remove, hostile): one or two sentences. "Understood" and a clean close. No door left open, no pitch, no apology beyond a brief one if we clearly overstepped.
- UNCLEAR or BROKER INTRO: answer what they actually asked or acknowledged, in the same voice, and ask one plain question if needed.`;

export function inboxDraftPrompt(params: {
  thread: ThreadMessage[];
  sentiment: Sentiment;
  isBrokerIntro: boolean;
  accountName: string | null;
  senderName: string | null;
  timingText: string | null;
  nextTouchDate: string | null;
  examples: Array<{ to: string; subject: string; body: string }>;
}): string {
  const type = params.isBrokerIntro ? "BROKER INTRO" : params.sentiment.toUpperCase();
  const thread = params.thread.slice(-4).map((m) => {
    const who = m.mine ? "SEB" : `${m.from || m.email}`;
    return `--- ${who}, ${m.at.slice(0, 10)} ---\n${m.text.trim().slice(0, 2000)}`;
  });
  const examples = params.examples.slice(0, 6).map((e, i) => `Example ${i + 1} (to ${e.to}, "${e.subject}"):\n${e.body.trim().slice(0, 900)}`);
  return [
    `Reply type: ${type}`,
    `Company: ${params.accountName ?? "unknown (no Salesforce account)"}`,
    `Sender: ${params.senderName ?? "unknown"}`,
    params.timingText ? `Timing they gave: "${params.timingText}"` : "Timing they gave: none",
    params.nextTouchDate ? `Next touch Seb has scheduled: ${params.nextTouchDate}` : "Next touch: none scheduled",
    "",
    "Thread, oldest first. Reply to the LAST message:",
    "",
    ...thread,
    "",
    examples.length > 0 ? "Recent replies Seb wrote himself, for voice only (do not copy their facts):" : "",
    ...examples,
    "",
    "Write Seb's reply now.",
  ].join("\n");
}

const BANNED = [
  /circle back/i, /touch base/i, /synerg/i, /strategic alignment/i, /unlock value/i,
  /explore potential/i, /leverage/i, /earliest convenience/i, /hope this (email )?finds you/i,
  /would be delighted/i, /do not hesitate/i, /\bkindly\b/i, /bump this/i, /extremely busy/i,
  /make sure you saw/i, /looking forward to hearing/i, /thank you in advance/i, /feel free to reach/i,
  /squarely/i, /\bthanks\b/i, /[–—]/,
];

/** Problems worth flagging before Seb sends. Empty when clean. */
export function validateDraft(body: string, theirsLength: number): string[] {
  const issues: string[] = [];
  const text = body.trim();
  if (!text) return ["The draft is empty."];
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) issues.push(`Contains "${m[0]}".`);
  }
  if (!/^(hi|hello|dear)\b/i.test(text)) issues.push("Does not start with a greeting.");
  if (!/\b(best|thank you|regards)\s*,?\s*\n+\s*(sebastian|seb)\s*$/i.test(text)) issues.push("Does not end with Best, / Sebastian or Thank you, / Seb.");
  if (theirsLength > 0 && text.length > Math.max(400, theirsLength * 1.6)) issues.push("Longer than their email.");
  return issues;
}

/** Normalise model output: strip quotes/code fences, dashes, double blank lines. */
export function normalizeDraft(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  t = t.replace(/^(subject\s*:.*\n+)/i, "");
  t = t.replace(/^"([\s\S]*)"$/, "$1");
  t = t.replace(/\s*[–—]\s*/g, ", ");
  t = t.replace(/\bThanks\b/g, "Thank you").replace(/\bthanks\b/g, "thank you");
  t = t.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Deterministic fallbacks when the model is unavailable. */
export function fallbackDraft(sentiment: Sentiment, firstName: string | null, timingText: string | null): string {
  const hi = `Hi ${firstName ?? "there"},`;
  if (sentiment === "positive") {
    return `${hi}\n\nThank you for the reply, and appreciate the willingness to speak. My scheduling assistant (copied) will send over a few times with a Teams invite.\n\nBest,\nSebastian`;
  }
  if (sentiment === "negative") {
    return `${hi}\n\nUnderstood. I will leave it there.\n\nBest,\nSebastian`;
  }
  const when = timingText ? `I'll check back in ${timingText.replace(/^in\s+/i, "")}` : "I'll check back in a few months";
  return `${hi}\n\nUnderstood, and appreciate the quick reply. ${when}.\n\nBest,\nSebastian`;
}

export function firstNameOfSender(name: string | null | undefined, email: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  if (n) {
    // "Zorkin, Niko" → Niko; "Niko Zorkin" → Niko; "Tim Bethlehem | Extendas" → Tim
    const cleaned = n.replace(/\s*[|(].*$/, "").trim();
    if (cleaned.includes(",")) return cleaned.split(",")[1]?.trim().split(/\s+/)[0] ?? null;
    const first = cleaned.split(/\s+/)[0];
    return first && /^[a-z][a-z'\-]*$/i.test(first) ? first : null;
  }
  const local = (email ?? "").split("@")[0] ?? "";
  const part = local.split(/[._-]/)[0];
  return part && part.length > 1 && /^[a-z]+$/i.test(part) ? part[0].toUpperCase() + part.slice(1).toLowerCase() : null;
}
