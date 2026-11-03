/**
 * Word fixes applied in code to every drafted email (RCE, nudges, follow-ups,
 * inbox replies, InMails), so a rule Seb set never depends on the model
 * remembering it. The prompt asks for the same thing; this is the backstop.
 *
 * - An email is an "email", never a "note".
 * - No em or en dashes. "thank you", never "thanks".
 * - Template phrases Seb never uses (Nov 2026 list): squarely, shifted,
 *   tracking, on the X side, remains strong, shaping up, from scratch,
 *   top of mind, on my radar, got buried.
 */
export const EMAIL_WORD_RULE =
  'Call an email an "email", never a "note". Never write "squarely", "if anything has shifted" (say "changed"), "how things are tracking", "on the growth side" or "on the ownership side", "remains strong", "shaping up", "so we\'re not starting from scratch", "top of mind", "on my radar", or "got buried".';

const SIDE_TOPICS =
  "growth|ownership|M&A|hiring|team|product|sales|business|deal|funding|capital|investment|strategy|financing|exit|succession|transaction|partnership|acquisition|operations|technology|tech|development|commercial|financial";

type Fix = [RegExp, string | ((...m: string[]) => string)];
const cap = (word: string, like: string) => (/^[A-Z]/.test(like) ? word[0].toUpperCase() + word.slice(1) : word);

const FIXES: Fix[] = [
  // "note" meaning an email. Not "of note", "to note", "note that".
  [/\b(a|A) note\b(?!\s+(that|how)\b)/g, (_m, a) => `${a === "A" ? "An" : "an"} email`],
  [/(?<!\b(?:of|to|I'd|I would|worth) )\b(N|n)ote(s?)\b(?!\s+(that|how)\b)/g, (_m, n, s) => `${n === "N" ? "E" : "e"}mail${s}`],
  // Dashes and "thanks".
  [/\s*[–—]\s*/g, ", "],
  [/\b(M|m)any thanks\b/g, (_m, m) => cap("thank you", m)],
  [/\bThanks\b(?! to\b)/g, "Thank you"],
  [/\bthanks\b(?! to\b)/g, "thank you"],
  // squarely: "fits squarely in" -> "fits in"
  [/\s+squarely\b/gi, ""],
  [/\bSquarely\s+/g, ""],
  // remains strong: "Our interest in Infonet remains strong" -> "We're still interested in Infonet"
  [/\b(Our|our|My|my) interest in ([^.,;\n]+?) (?:remains|is still|continues to be) (?:strong|high)\b/g, (_m, p, x) => `${cap("we're", p)} still interested in ${x}`],
  [/\b(Our|our|My|my) interest (?:remains|is still|continues to be) (?:strong|high)\b/g, (_m, p) => `${cap("we're", p)} still interested`],
  // from scratch: "..., so we're not starting from scratch if ..." -> cut the clause
  [/,?\s*so (?:that )?(?:we're|we are|we) (?:not|aren't|don't|do not) (?:starting|start) from scratch[^.!?\n]*/gi, ""],
  // got buried: "follow up in case my email from June got buried" -> "follow up on my email from June"
  [/\s+in case (my|the|this|that)\b([^.,;\n]*?)\s*got buried/gi, (_m, a, b) => ` on ${a}${b}`],
  // tracking: "how things are tracking on the growth side" -> "how growth is going"
  [new RegExp(`\\bhow (?:things|the business|business|everything|it) (?:is|are) (?:tracking|going) on the (${SIDE_TOPICS}) (?:side|front)\\b`, "g"), "how $1 is going"],
  [/\bhow (things|the business|business|everything|the year|it|growth) (is|are|has been|have been) tracking\b/gi, "how $1 $2 going"],
  // on the X side: "if anything has changed on the ownership side" -> "... on ownership"
  [new RegExp(`\\bon the (${SIDE_TOPICS}) (?:side|front)\\b`, "g"), "on $1"],
  // shaping up: "how the year is shaping up" -> "how the year is going"
  [/\bshaping up\b/g, "going"],
  // shifted: verbs only, so crew "shifts" and "shift scheduling" stay.
  [/\bshifted\b/g, "changed"],
  [/\bShifted\b/g, "Changed"],
  [/\b(anything|something|thinking|ever|that|things|plans|priorities) shifts\b/g, "$1 changes"],
  [/\b(will|might|may|could|would|to) shift\b(?! (scheduling|planning|patterns?|work|workers|management)\b)/g, "$1 change"],
  // top of mind: "TimberTec stays top of mind for me" -> "I keep coming back to TimberTec"
  [/\b([A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*){0,3}) (?:stays|remains|has stayed|has remained|is still|is) top of mind(?: for (?:me|us))?/g, "I keep coming back to $1"],
  [/\btop of mind\b/g, "on my mind"],
  // radar: "X has been on my radar" -> "I've been following X"
  [/\b([A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*){0,3}) has been on (?:my|our) radar\b/g, "I've been following $1"],
  [/\bon (?:my|our) radar\b/g, "on my mind"],
  [/\bon your radar\b/g, "in front of you"],
];

export function fixEmailWords(text: string): string {
  let out = text;
  for (const [re, to] of FIXES) out = out.replace(re, to as never);
  return out.replace(/ {2,}/g, " ").replace(/ +([.,!?])/g, "$1");
}

/** Phrases still present after the fixes. Used by tests; empty means clean. */
export function bannedLeft(text: string): string[] {
  const checks = [/\bnotes?\b(?! that)/i, /squarely/i, /\bshifted\b/i, /\btracking\b(?! software| system| platform)/i, /remains strong/i, /shaping up/i, /from scratch/i, /top of mind/i, /radar/i, /got buried/i, /[–—]/, /\bthanks\b(?! to)/i];
  return checks.filter((re) => re.test(text)).map((re) => re.source);
}
