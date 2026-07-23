import fs from "fs";
import path from "path";

// Builds a ready-to-send "Email 1" draft by dropping the sourcing tool's
// already-generated pieces (hook, outreach paragraph, town + week) into the
// matched subgroup's template in content/email-sequences.md.
//
// Every swap is PLAIN STRING replacement — no AI call — so the template wording
// stays exactly as written and Salesforce merge fields ({{...}}) pass through
// untouched.

export type PrepackagedEmail = {
  subject: string | null; // e.g. "Capital Grille Lunch Aug 12: Valstone"
  body: string | null; // finished draft; null when skipped
  templateSubgroup: string | null; // e.g. "Manufacturing — Production Quality"
  warnings: string[]; // things to double-check before sending
  skipped: boolean;
  skipReason: string | null;
};

// The exact template strings we replace. These appear verbatim in every
// "Email 1 — Initial Outreach" body in content/email-sequences.md.
const HOOK_SENTENCE =
  "I have studied {{account.name}} going back to the release of (INSERT PRODUCT).";
const TOWN_WEEK_PLACEHOLDER = "[INSERT TOWN AND WEEK]";
const CORE_PARAGRAPH_PREFIX = "We are building a dedicated";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Short month labels used in the subject-line date, e.g. "Aug 12".
const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// First day-of-month of each ordinal week block (weeks are the 1-7 / 8-14 /
// 15-21 / 22-28 day ranges).
const ORDINAL_START_DAY: Record<string, number> = {
  first: 1,
  second: 8,
  third: 15,
  fourth: 22,
};

// The name to drop into {{sender.first_name}} while this is a single-user tool.
// The template keeps the merge field so multi-user (each with their own login)
// still works later — we only substitute in the generated draft.
const SENDER_FIRST_NAME = "Sebastian";

// Generic cuisine/venue descriptor words. When one appears, we drop it and
// everything after it, keeping the distinctive brand in front:
//   "Eddie V's Prime Seafood" → "Eddie V's"
//   "Ruth's Chris Steak House" → "Ruth's Chris"
// "Grill"/"Grille" is intentionally NOT in the list so "The Capital Grille"
// stays "Capital Grille".
const RESTAURANT_DESCRIPTORS = [
  "Prime Seafood", "Prime", "Seafood", "Steak House", "Steakhouse",
  "Chop House", "Chophouse", "Restaurant", "Ristorante", "Trattoria",
  "Bar & Grill", "Bar and Grill", "Bar", "Kitchen", "Tavern", "Bistro",
  "Cantina", "Cocktail", "Brasserie", "Brewhouse", "Grillhouse",
];

// Shorten a full restaurant name to the short brand form used in the subject.
function shortenRestaurantName(raw: string): string {
  let s = raw.trim().replace(/^the\s+/i, "");

  // Find the earliest descriptor keyword (whole word) and cut there.
  let cutIdx = -1;
  for (const kw of RESTAURANT_DESCRIPTORS) {
    const re = new RegExp(
      `\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );
    const m = s.match(re);
    if (m && m.index != null && m.index > 0 && (cutIdx === -1 || m.index < cutIdx)) {
      cutIdx = m.index;
    }
  }
  if (cutIdx > 0) s = s.slice(0, cutIdx);

  // Trim trailing separators/punctuation left behind by the cut.
  s = s.replace(/[\s,\-–—&]+$/, "").trim();
  return s || raw.trim();
}

function loadEmailSequences(): string {
  const filePath = path.join(process.cwd(), "content", "email-sequences.md");
  return fs.readFileSync(filePath, "utf-8");
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Split a section header like "Manufacturing — Production Quality" into its
// main-group and subgroup halves (on the em dash).
function parseHeader(header: string): { main: string; sub: string } | null {
  const parts = header.split("—");
  if (parts.length < 2) return null;
  return {
    main: parts[0].trim(),
    sub: parts.slice(1).join("—").trim(),
  };
}

// Pull the "Email 1 — Initial Outreach" body out of a section, stopping at the
// next subheading (### / ---) and dropping editorial notes like
// "*(No Email 2 or Email 3 written yet…)*".
function extractEmail1(sectionBody: string): string | null {
  const subs = sectionBody.split(/\n### /);
  for (const sub of subs) {
    if (!/^Email 1\b/i.test(sub.trim())) continue;
    const nl = sub.indexOf("\n");
    let body = nl === -1 ? "" : sub.slice(nl + 1);
    body = body.split(/\n---/)[0];
    return body.trim();
  }
  return null;
}

function findEmail1Section(
  fileContent: string,
  mainGroup: string | null,
  subgroup: string,
): { header: string; email1Body: string } | null {
  // chunks[0] is the preamble; each subsequent chunk begins with a header line.
  const chunks = fileContent.split(/\n## /);
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const nl = chunk.indexOf("\n");
    const header = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const parsed = parseHeader(header);
    if (!parsed) continue;
    if (norm(parsed.sub) !== norm(subgroup)) continue;
    if (mainGroup && norm(parsed.main) !== norm(mainGroup)) continue;

    const email1Body = extractEmail1(nl === -1 ? "" : chunk.slice(nl + 1));
    if (email1Body) return { header, email1Body };
  }
  return null;
}

// City = the second-to-last comma-separated part of a US-style address
// ("11340 Lakefield Dr, Johns Creek, GA 30097" → "Johns Creek"), or the sole
// part when there are no commas.
function parseCity(address: string): string | null {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts[parts.length - 2];
}

// The lunch is pitched ~3 weeks out. Returns both the body phrase
// ("the second week of August") and the specific Wednesday of that same week
// as a short date ("Aug 12") for the subject line — both derived from one
// reference so the subject date and the body's week never disagree.
function referenceWeek(now: Date): { phrase: string; shortDate: string } {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 21);
  const day = d.getDate();
  let ordinal: string;
  let monthIdx = d.getMonth();
  let year = d.getFullYear();
  if (day <= 7) ordinal = "first";
  else if (day <= 14) ordinal = "second";
  else if (day <= 21) ordinal = "third";
  else if (day <= 28) ordinal = "fourth";
  else {
    // 29th or later → roll into the first week of next month.
    ordinal = "first";
    monthIdx += 1;
    if (monthIdx > 11) {
      monthIdx = 0;
      year += 1;
    }
  }

  // The Wednesday inside that week's day-of-month block. Any 7 consecutive days
  // contain exactly one Wednesday (getDay() === 3).
  const startDay = ORDINAL_START_DAY[ordinal];
  let wednesday = new Date(year, monthIdx, startDay);
  for (let i = 0; i < 7; i++) {
    const cand = new Date(year, monthIdx, startDay + i);
    if (cand.getDay() === 3) {
      wednesday = cand;
      break;
    }
  }

  return {
    phrase: `the ${ordinal} week of ${MONTHS[monthIdx]}`,
    shortDate: `${SHORT_MONTHS[monthIdx]} ${wednesday.getDate()}`,
  };
}

export function buildPrepackagedEmail(args: {
  mainGroup: string | null;
  subgroup: string | null;
  emailHook: string | null;
  outreachParagraph: string | null;
  address: string | null;
  locationConfidence: "exact" | "city" | "none";
  restaurants: { name: string; description: string }[];
  now: Date;
}): PrepackagedEmail {
  const {
    mainGroup,
    subgroup,
    emailHook,
    outreachParagraph,
    address,
    locationConfidence,
    restaurants,
    now,
  } = args;

  if (!subgroup) {
    return {
      subject: null,
      body: null,
      templateSubgroup: null,
      warnings: [],
      skipped: true,
      skipReason:
        "No portfolio subgroup matched, so no email template could be selected.",
    };
  }

  let fileContent: string;
  try {
    fileContent = loadEmailSequences();
  } catch {
    return {
      subject: null,
      body: null,
      templateSubgroup: null,
      warnings: [],
      skipped: true,
      skipReason: "Email template file could not be read.",
    };
  }

  const section = findEmail1Section(fileContent, mainGroup, subgroup);
  if (!section) {
    return {
      subject: null,
      body: null,
      templateSubgroup: null,
      warnings: [],
      skipped: true,
      skipReason: `No email template exists yet for the "${subgroup}" subgroup.`,
    };
  }

  const warnings: string[] = [];
  let body = section.email1Body;

  // 1. Swap the hook sentence. Use a replacer function so any "$" in the hook
  //    is treated literally.
  if (emailHook) {
    const replaced = body.replace(HOOK_SENTENCE, () => emailHook);
    if (replaced === body) {
      warnings.push(
        "Could not find the hook placeholder in the template — the hook was not inserted.",
      );
    }
    body = replaced;
  } else {
    warnings.push(
      "Email hook was not generated — the template's placeholder sentence is still in place.",
    );
  }

  // 2. Swap the core paragraph (and drop editorial notes).
  const paragraphs = body.split(/\n\n+/);
  const rebuilt: string[] = [];
  let swappedCore = false;
  for (const p of paragraphs) {
    const t = p.trim();
    if (/^\*\(.*\)\*$/.test(t)) continue; // editorial note like *(No Email 2…)*
    if (!swappedCore && t.startsWith(CORE_PARAGRAPH_PREFIX)) {
      swappedCore = true;
      if (outreachParagraph) {
        rebuilt.push(outreachParagraph.trim());
      } else {
        warnings.push(
          "Outreach paragraph was not generated — the generic template paragraph is still in place.",
        );
        rebuilt.push(p);
      }
      continue;
    }
    rebuilt.push(p);
  }
  if (!swappedCore) {
    warnings.push("Could not locate the core paragraph to personalize.");
  }
  body = rebuilt.join("\n\n");

  // 3. Fill in town + week.
  const { phrase: week, shortDate: lunchDate } = referenceWeek(now);
  const town =
    locationConfidence !== "none" && address ? parseCity(address) : null;
  let townWeek: string;
  if (town) {
    townWeek = `${town} on ${week}`;
  } else {
    townWeek = `[INSERT TOWN] on ${week}`;
    warnings.push(
      "Town could not be determined — [INSERT TOWN] is left in the draft; fill it in before sending.",
    );
  }
  body = body.replace(TOWN_WEEK_PLACEHOLDER, () => townWeek);

  // 4. Fill the sender name (single-user tool for now).
  body = body.split("{{sender.first_name}}").join(SENDER_FIRST_NAME);

  // 5. Subject line: "<short restaurant name> Lunch <Mon DD>: Valstone", where
  //    the date is the Wednesday of the week the email body references.
  const chosenRestaurant = restaurants.find((r) => r.name && r.name.trim());
  let subject: string;
  if (chosenRestaurant) {
    subject = `${shortenRestaurantName(chosenRestaurant.name)} Lunch ${lunchDate}: Valstone`;
  } else {
    subject = `[RESTAURANT] Lunch ${lunchDate}: Valstone`;
    warnings.push(
      "No restaurant was found — [RESTAURANT] is left in the subject; fill it in before sending.",
    );
  }

  return {
    subject,
    body: body.trim(),
    templateSubgroup: section.header,
    warnings,
    skipped: false,
    skipReason: null,
  };
}
