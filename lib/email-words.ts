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
  // "note" meaning an email, only where it can only mean one: "my last note",
  // "sent you a note", "exchanged notes". Never "field notes", "release notes",
  // "comparing notes", "call notes".
  // Singular is always the email ("my note from June"). Plural only after a
  // preposition ("follow up on my notes"): "My notes from April have TRU
  // moving..." means call notes and stays.
  [/\b(my|your|our|his|her|their)( (?:last|previous|earlier|recent|quick|short|first|second|final))? note\b/gi, (_m, p, adj) => `${p}${adj ?? ""} email`],
  [/\b(on|to|after|since|about|in) (my|your|our)( (?:last|previous|earlier|recent))? notes\b/gi, (_m, prep, p, adj) => `${prep} ${p}${adj ?? ""} emails`],
  [/\b(last|previous|earlier) note(s?)\b/gi, (_m, w, s) => `${w} email${s}`],
  [/\b(sent|send|sending|wrote|write|drop|dropped|shoot|shot)( you| him| her| them)? (a|the) (quick |short |brief )?note\b/gi, (_m, v, who, art, adj) => `${v}${who ?? ""} ${art.toLowerCase() === "the" ? art : adj ? art : art === "A" ? "An" : "an"} ${adj ?? ""}email`],
  [/\bexchanged notes\b/gi, "exchanged emails"],
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
  [/\b(stays|remains|has stayed|has remained|is still|is) top of mind(?: for (me|us))?/g, (_m, _v, who) => `keeps coming up${who ? ` for ${who}` : ""}`],
  [/\btop of mind\b/g, "on my mind"],
  // radar: "X has been on my radar" -> "I've been following X"
  [/\b([A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*){0,3}) has been on (?:my|our) radar\b/g, "I've been following $1"],
  [/\bon my radar\b/g, "on my mind"],
  [/\bon our radar\b/g, "on our minds"],
  [/\bon your radar\b/g, "in front of you"],
];

export function fixEmailWords(text: string): string {
  let out = text;
  for (const [re, to] of FIXES) out = out.replace(re, to as never);
  // Tidy only the gaps a removal left ("fits  in", "in .") and never ".NET".
  return out.replace(/ {2,}/g, " ").replace(/ +([.,!?])(?=\s|$)/g, "$1");
}

/** Wording Seb never uses, with the label shown when a draft still contains it. */
const BANNED: Array<[RegExp, string]> = [
  [/\b(my|your|our|last|previous|earlier) (last |previous |earlier |recent |quick )?note\b|\b(on|to|after|since|about|in) (my|your|our) (last |previous |earlier |recent )?notes\b|\b(sent|wrote|drop|dropped) (you )?(a|the) (quick |short )?note\b|exchanged notes/i, '"note" for an email'],
  [/[\u2013\u2014]/, "a dash"],
  [/\bthanks\b(?! to\b)/i, '"thanks"'],
  [/squarely/i, '"squarely"'],
  [/\bshifted\b/i, '"shifted"'],
  [/\bhow (things|the business|business|everything|it) (is|are) tracking\b/i, '"how things are tracking"'],
  [/\bon the [a-z&]+ (side|front)\b/i, '"on the ... side"'],
  [/remains (strong|high)/i, '"remains strong"'],
  [/shaping up/i, '"shaping up"'],
  [/from scratch/i, '"from scratch"'],
  [/top of mind/i, '"top of mind"'],
  [/\bradar\b/i, '"on my radar"'],
  [/got buried/i, '"got buried"'],
  [/circle back|circling back/i, '"circle back"'],
  [/touch base/i, '"touch base"'],
  [/synerg/i, '"synergies"'],
  [/strategic alignment/i, '"strategic alignment"'],
  [/unlock value/i, '"unlock value"'],
  [/explore potential/i, '"explore potential opportunities"'],
  [/leverage our/i, '"leverage our platform"'],
  [/earliest convenience/i, '"at your earliest convenience"'],
  [/hope (this|my) (email|message) finds you/i, '"hope this email finds you well"'],
  [/hope all is well/i, '"hope all is well"'],
  [/reach out to introduce/i, '"reach out to introduce myself"'],
  [/would be delighted/i, '"we would be delighted"'],
  [/do not hesitate|don't hesitate/i, '"do not hesitate"'],
  [/\bkindly\b/i, '"kindly"'],
  [/bump this/i, '"bump this"'],
  [/extremely busy/i, '"extremely busy"'],
  [/make sure you saw/i, '"make sure you saw this"'],
  [/looking forward to hearing/i, '"looking forward to hearing from you"'],
  [/thank you in advance/i, '"thank you in advance"'],
  [/feel free to reach out/i, '"feel free to reach out"'],
];

/** Banned wording still present in a draft, as short labels. Empty means clean. */
export function bannedLeft(text: string): string[] {
  return BANNED.filter(([re]) => re.test(text)).map(([, label]) => label);
}
