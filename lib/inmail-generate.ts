/**
 * Convert a sent E1 cold email (as stored in Salesforce) into two LinkedIn
 * InMail messages, then check the result against rules the model is not
 * trusted to follow on its own. Anything that fails a check is flagged so
 * the queue shows "needs a look" instead of a copy button.
 */

export const INMAIL_SYSTEM_PROMPT = `You convert cold outreach emails into LinkedIn InMail messages. You receive the full E1 (original cold email) and output two messages: an initial InMail and a follow-up.

INITIAL INMAIL RULES:
Opening line:
- First line is exactly: "[First Name], I sent you a few emails recently but wanted to try here as well."
- Then keep the research hook sentence from the E1 intact (the sentence that starts with "I have studied" or "I have followed" ... "going back to ...").

Middle paragraph:
- Replace "We are a global provider of mission-critical software, focused on industrial end markets where operations rely on reliable systems every day" (or any close variant) with "We are a global provider of mission-critical software focused on industrial end markets".
- Replace "My name is [anyone], and I lead investment efforts at Valstone" with "I lead investment efforts at Valstone".
- Keep the group name and vision statement.
- Condense the operational capability list into bookends: keep the first 1-2 items and the last 2-3 items, connected with "from [first items] through to [last items]." Drop the middle items.
- If there is a target-specific product callout (e.g. "Tools like HQMS...", "What you have built with TrakQuip..."), keep it as one sentence after the bookend.
- If there is a portfolio acquisition reference (Documoto, Henning, DISCUS, Nascent, PigKnows, etc.), keep it.
- If there is a "global customer base" line, keep it.
- Drop any "In simple terms..." sentence.

Closing:
- If the E1 names a travel location, replace the dates with "in a few weeks": "Would love to find time to discuss, as I am planning to be near [Location] in a few weeks. Happy to work around your schedule."
- If there is no travel location: "Would love to find time to discuss. Happy to work around your schedule."
- Drop "Please let me know if available".
- Sign off exactly: "Best,\\nSeb"

FOLLOW-UP INMAIL (static): "[First Name], just following up on my earlier message. Would love to connect if you have 20 minutes. Happy to work around your schedule.\\n\\nBest,\\nSeb"

GLOBAL RULES:
- Always replace Nate, Tyson, Sebastian or any other sender name with Seb.
- Fix typos from the original.
- Never use em dashes; use commas, full stops, or parentheses.
- Keep "mission-critical" and "long-term" hyphenated.
- Never use: synergies, strategic alignment, unlock value, explore potential opportunities, leverage, at your earliest convenience, please do not hesitate, kindly, looking forward to hearing from you, thank you in advance.
- Output valid JSON only, no prose, no code fences: {"initial": "...", "followup": "..."}`;

export function inmailUserPrompt(firstName: string, e1Body: string): string {
  return `Convert this E1 email into two LinkedIn InMail messages. Contact name: ${firstName}. Output JSON only.\n\nE1 BODY:\n${e1Body}`;
}

export const INMAIL_MAX_CHARS = 1900; // LinkedIn InMail body limit

const BANNED = [
  "synergies", "strategic alignment", "unlock value", "explore potential opportunities",
  "leverage", "at your earliest convenience", "please do not hesitate", "kindly",
  "looking forward to hearing from you", "thank you in advance", "in simple terms",
  "i hope this", "circle back", "touch base",
];

export function followUpTemplate(firstName: string): string {
  return `${firstName}, just following up on my earlier message. Would love to connect if you have 20 minutes. Happy to work around your schedule.\n\nBest,\nSeb`;
}

/** The research hook sentence of an E1, if present. */
export function extractHookSentence(e1Body: string): string | null {
  const match = e1Body.match(/I have (?:studied|followed)\b[^.]*?\bgoing back to\b[^.]*\./i);
  return match ? match[0].trim() : null;
}

/** Loose JSON pull: tolerates code fences and leading prose. */
export function parseInMailJson(raw: string): { initial: string; followup: string } | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { initial?: unknown; followup?: unknown };
    if (typeof parsed.initial !== "string" || !parsed.initial.trim()) return null;
    const followup = typeof parsed.followup === "string" && parsed.followup.trim() ? parsed.followup : "";
    return { initial: parsed.initial.trim(), followup: followup.trim() };
  } catch {
    return null;
  }
}

/** Mechanical fixes that are always safe to apply. */
export function normalizeInMail(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, ", ")
    .replace(/mission critical/gi, "mission-critical")
    .replace(/long term home/gi, "long-term home")
    .replace(/\bBest,\s*\n?\s*(Nate|Tyson|Sebastian)\b/g, "Best,\nSeb")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Check the generated initial InMail. Returns the problems found; an empty
 * array means it is safe to show with a Copy button.
 */
export function validateInitialInMail(args: {
  text: string;
  firstName: string;
  e1Body: string;
}): string[] {
  const problems: string[] = [];
  const { text, firstName, e1Body } = args;
  const expectedOpener = `${firstName}, I sent you a few emails recently but wanted to try here as well.`;
  // The hook may follow the opener on the same line, so "starts with" is the test.
  if (!normalizeForCompare(text).startsWith(normalizeForCompare(expectedOpener))) {
    problems.push(`Opening line is not "${expectedOpener}"`);
  }
  const hook = extractHookSentence(e1Body);
  if (hook) {
    const hookKey = normalizeForCompare(hook).replace(/^i have (studied|followed) /, "");
    if (!normalizeForCompare(text).includes(hookKey.slice(0, Math.min(hookKey.length, 60)))) {
      problems.push("The research hook sentence from the E1 is missing or changed");
    }
  }
  if (/—|–/.test(text)) problems.push("Contains an em or en dash");
  const lower = text.toLowerCase();
  for (const phrase of BANNED) {
    if (lower.includes(phrase)) problems.push(`Contains "${phrase}"`);
  }
  if (/\b(Nate|Tyson|Sebastian)\b/.test(text)) problems.push("Mentions a sender name other than Seb");
  if (!/Best,\s*\nSeb\s*$/.test(text)) problems.push('Does not end with "Best,\\nSeb"');
  if (/please let me know if available/i.test(text)) problems.push('Still says "Please let me know if available"');
  if (text.length > INMAIL_MAX_CHARS) problems.push(`Too long for an InMail (${text.length} characters, limit ${INMAIL_MAX_CHARS})`);
  if (text.length < 200) problems.push("Suspiciously short");
  return problems;
}

/** Full name -> first name for the opener; falls back to null when unusable. */
export function firstNameOf(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0]?.replace(/[^A-Za-zÀ-ÿ'’-]/g, "");
  if (!first || first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Sales Navigator people search for a name at a company (no API needed). */
export function navigatorSearchUrl(fullName: string, company: string | null): string {
  const keywords = [fullName, company].filter(Boolean).join(" ");
  return `https://www.linkedin.com/sales/search/people?keywords=${encodeURIComponent(keywords)}`;
}

export function googleLinkedInUrl(fullName: string, company: string | null): string {
  const q = `"${fullName}" ${company ? `"${company}" ` : ""}site:linkedin.com/in`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/**
 * InMail subject, in the same shape as Seb's cold-email subjects: short,
 * specific, nothing that reads like marketing. "Valstone / Cargosnap".
 */
export function inmailSubject(company: string | null): string {
  const name = (company ?? "").trim();
  return name ? `Valstone / ${name}` : "Valstone";
}
