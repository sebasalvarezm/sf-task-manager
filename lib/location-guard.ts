/**
 * Guards against AI narration leaking into places where only a location
 * belongs. The address lookup once returned "I'll search for Route4Me's
 * headquarters using multiple queries simultaneously." and, because the
 * company name contains a digit, it passed the old "looks like an address"
 * check and landed in an outreach email as the town. These helpers are the
 * single gate for every location string before it is stored or rendered.
 */

// Words that show up in model commentary and never in a real address/town.
const NARRATION = new RegExp(
  "\\b(" +
    [
      "i'?ll", "i will", "i'?m", "i am", "i need", "i can", "i cannot", "i can'?t",
      "let me", "let'?s", "we'?ll", "we will", "we can",
      "search(?:ing|es|ed)?", "quer(?:y|ies)", "look(?:ing|ed)? (?:for|up|into)",
      "find(?:ing)?", "found", "using", "based on", "according to", "appears?",
      "seems?", "unable", "cannot", "can'?t", "couldn'?t", "here (?:is|are)",
      "the company", "this company", "headquarters", "head office", "website",
      "result(?:s)?", "information", "please", "sorry", "unfortunately",
      "multiple", "simultaneously", "attempt(?:ing|s)?", "try(?:ing)?", "tried",
      "return(?:ing|ed)?", "provide[ds]?", "determine[ds]?", "located in",
      "is based", "are based", "not (?:available|found|listed|clear)",
    ].join("|") +
    ")\\b",
  "i",
);

// Standalone street number, ZIP / postal code, or Canadian postal code.
const STREET_OR_POSTAL_NUMBER =
  /(^|[\s,#])\d{1,6}[A-Za-z]?(?=$|[\s,.-])|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b\d{4}\s?[A-Z]{2}\b|\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/;

// "City, ST" / "City, Region" / "City, Country"
const CITY_REGION = /,\s*(?:[A-Z]{2,3}\b|[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+)*)/;

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/**
 * True when `value` plausibly is a postal address or a "City, Region" pair
 * and definitely is not a sentence of model commentary.
 */
export function looksLikeAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v.length < 4 || v.length > 200) return false;
  if (NARRATION.test(v)) return false;
  if (words(v).length > 14) return false;
  // A sentence ending in a period with no digits and no comma is prose.
  if (/[.!?]$/.test(v) && !/\d/.test(v) && !v.includes(",")) return false;
  return STREET_OR_POSTAL_NUMBER.test(v) || CITY_REGION.test(v);
}

/**
 * True when `value` is a town / "Town, ST" that can be dropped into
 * "I will be near ___": short, capitalised, no digits, no commentary.
 */
export function looksLikeTown(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v.length < 2 || v.length > 60) return false;
  if (/\d/.test(v)) return false;
  if (NARRATION.test(v)) return false;
  if (/[.!?]$/.test(v) && !/\b(?:St|Ste|Mt|Ft)\.$/.test(v)) return false;
  const parts = words(v.replace(/,/g, " "));
  if (parts.length === 0 || parts.length > 5) return false;
  // Every word starts with a capital letter, apart from joiners like
  // "de", "la", "on", "upon", "am", "sur", "of", "the".
  const joiner = /^(?:de|del|della|di|da|la|le|les|los|las|van|von|der|den|on|upon|am|im|an|sur|of|the|and|y|et)$/i;
  return parts.every((w) => joiner.test(w) || /^[A-ZÀ-Þ]/.test(w) || /^(?:St|Ste|Mt|Ft)\.?$/i.test(w));
}

/** Convenience: returns the trimmed value when it passes, otherwise null. */
export function guardAddress(value: string | null | undefined): string | null {
  return looksLikeAddress(value) ? value!.trim() : null;
}

export function guardTown(value: string | null | undefined): string | null {
  return looksLikeTown(value) ? value!.trim() : null;
}
