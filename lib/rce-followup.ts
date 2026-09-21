/**
 * The short second email that follows a reconnect (RCE) when nobody replied.
 *
 * These are Seb's own follow-ups, used verbatim with only the first name and
 * the sign-off swapped. No model call: the voice is fixed and three sentences
 * long, and a template cannot drift into "hope this finds you well".
 */

export type FollowUpTemplate = {
  /** Body without the sign-off. `{first}` is the recipient's first name. */
  body: string;
};

export const RCE_FOLLOW_UP_TEMPLATES: FollowUpTemplate[] = [
  {
    body: "{first},\n\nFollowing up once more. Would love to discuss a potential acquisition.",
  },
  {
    body: "Hi {first},\n\nFollowing up a final time. Are you available to catch-up and resume acquisition discussions in the next week or two?",
  },
  {
    body: "{first}, quickly following up on my last email.\n\nWould love to have a brief discussion in the next week or two. Our interest remains strong.",
  },
];

export const FOLLOW_UP_SIGNATURE = "Seb";

/** "Have a great weekend" on Thursday and Friday, "Best" otherwise. */
export function followUpCloser(now: Date): string {
  const day = now.getDay(); // 0 = Sunday
  return day === 4 || day === 5 ? "Have a great weekend," : "Best,";
}

/** "Charles Smith" -> "Charles"; "smith, charles" -> "Charles"; junk -> null. */
export function firstNameFrom(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  let name = fullName.trim();
  if (!name || name.includes("@")) return null;
  if (name.includes(",")) {
    // "Smith, Charles" ordering
    const [, rest] = name.split(",");
    name = (rest ?? "").trim();
  }
  const first = name.split(/\s+/)[0]?.replace(/[^A-Za-zÀ-ÿ'’-]/g, "");
  if (!first || first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * The name the first email opened with: "Hi Charles," / "Charles," / "Dear Mr. Lee,".
 * Used when the recipient's display name is missing from Outlook.
 */
export function firstNameFromGreeting(draft: string | null | undefined): string | null {
  if (!draft) return null;
  const firstLine = draft.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const match = firstLine.match(
    /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))?\s*(?:mr\.?|ms\.?|mrs\.?|dr\.?)?\s*([A-Z][A-Za-zÀ-ÿ'’-]+)\s*[,!.-]/i,
  );
  if (!match) return null;
  const name = match[1];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Stable pick so the same account always previews the same template. */
export function pickTemplateIndex(seed: string, count = RCE_FOLLOW_UP_TEMPLATES.length): number {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return count === 0 ? 0 : hash % count;
}

export const FIRST_NAME_PLACEHOLDER = "[First name]";

export function buildRceFollowUp(args: {
  seed: string;
  firstName: string | null;
  now: Date;
  templateIndex?: number;
}): { body: string; usedPlaceholder: boolean } {
  const index = args.templateIndex ?? pickTemplateIndex(args.seed);
  const template = RCE_FOLLOW_UP_TEMPLATES[index] ?? RCE_FOLLOW_UP_TEMPLATES[0];
  const first = args.firstName ?? FIRST_NAME_PLACEHOLDER;
  const body = `${template.body.split("{first}").join(first)}\n\n${followUpCloser(args.now)}\n${FOLLOW_UP_SIGNATURE}`;
  return { body, usedPlaceholder: args.firstName === null };
}

export function daysBetween(fromIso: string, now: Date): number {
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((now.getTime() - from) / 86_400_000));
}
