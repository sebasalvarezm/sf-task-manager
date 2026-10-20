import { getAnthropicClient, MODELS, stripCites } from "@/lib/anthropic";
import { fetchAccountDetails, fetchRecentAccountActivity } from "@/lib/salesforce-prep";
import { fetchPageText } from "@/lib/scout";

export type OnePagerContent = {
  companyName: string;
  generatedOn: string;
  quickBrief: string;
  businessModel: string;
  relationshipCatchUp: string;
  whatTheyDo: string;
  customers: string;
  companyHistory: string;
  recentNews: string[];
};

export type PrepInput = {
  accountId?: string;
  accountName?: string;
  website?: string;
  domain?: string;
  prepMode?: "first_call" | "reconnect";
};

async function scrapeWebsite(baseUrl: string): Promise<string> {
  const normalized = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const base = normalized.replace(/\/+$/, "");
  const pages = [base, base + "/about", base + "/about-us", base + "/company"];

  const MAX_CHARS = 10000;
  const fetched = await Promise.all(pages.map((pageUrl) => fetchPageText(pageUrl, 8000)));
  const results: string[] = [];
  let totalChars = 0;
  fetched.forEach((text, index) => {
    if (!text || text.length <= 100 || totalChars >= MAX_CHARS) return;
    const trimmed = text.slice(0, MAX_CHARS - totalChars);
    results.push(`--- Page: ${pages[index]} ---\n${trimmed}`);
    totalChars += trimmed.length;
  });
  return results.join("\n\n");
}

/**
 * House style for the one-pager. Sonnet 5.5 writes well but pads and editorialises
 * when left alone, so the format is pinned here as rules, with word caps the code
 * enforces below.
 */
const PREP_STYLE = `You write Valstone's call-prep one-pagers. They are read in two minutes before an M&A call, so every sentence must earn its place.

Voice: plain English a smart 12-year-old would follow, with no loss of precision. Short sentences, one idea each. Say what the company does, who pays, and why; do not sell it. Write "VMS" for vertical market software. Use "software", "customers", "owner", "founder", "acquisition"; never "solutions", "leverage", "ecosystem", "robust", "cutting-edge", "positions itself", "best-in-class", "seamless", "empowers", "end-to-end", "mission-critical" (unless quoting), or any banker or marketing phrasing.

Discipline: no preamble, no concluding or summary sentence, no "notably", "importantly", "it is worth noting", "interestingly". Do not repeat the company name every sentence; use "they" or "the company". Do not stack adjectives. Do not copy slogans from the website. Do not speculate about fit with Valstone, valuation, or deal angle unless a field asks for a call angle. Do not pad a thin fact base: write "Not available" for what the evidence does not cover rather than filling space. No dashes as punctuation; use commas, full stops, or parentheses. No bullet points, headers, markdown, or citation tags inside any field; each field is one plain paragraph.

The use case: the customers field ends with a worked example that starts "For example, ..." and runs 60 to 100 words on its own. It is a short scene, not a statistic: a named kind of user on a real day, what the job looked like without the software (the time lost, the paper, the drive, the guesswork), then what it looks like with it, step by step, ending with the downstream payoff (the invoice, the report, the compliance record). Model it on this one, matching its shape and concreteness: "For example, imagine a paving subcontractor showing up at dawn to place asphalt on a 12-mile interstate widening project. Without OnStation, a foreman might spend 20 to 30 minutes driving the corridor trying to locate the exact station marker where yesterday's paving ended. With OnStation, the crew opens the app, sees their precise position overlaid on the project alignment, navigates directly to the right spot, and immediately begins work, then documents the footage paved with geo-tagged photos that automatically feed into the prime contractor's payment application for that pay period." Invent the scene only from the kind of work the evidence shows the software does; never invent a named customer or a number the evidence does not support.

Length is a hard limit, not a target: whatTheyDo 70 to 120 words; customers 140 to 220 words, of which the "For example, ..." scene is 60 to 100; companyHistory 90 to 150 words; quickBrief 5 to 7 sentences; businessModel and relationshipCatchUp at most 80 words each; each recentNews item one sentence under 30 words with a month and year.`;

/** Word caps the code enforces after the model answers. */
const WORD_CAPS: Partial<Record<keyof OnePagerContent, number>> = {
  whatTheyDo: 130,
  customers: 240,
  companyHistory: 165,
  quickBrief: 160,
  businessModel: 90,
  relationshipCatchUp: 90,
};

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * A section that ran long gets one rewrite to its cap, facts kept, nothing added.
 * Rare after the style rules, so the extra call is the exception, not the rule.
 */
async function tightenSections(
  anthropic: NonNullable<ReturnType<typeof getAnthropicClient>>,
  content: OnePagerContent,
): Promise<OnePagerContent> {
  const out = { ...content };
  for (const [field, cap] of Object.entries(WORD_CAPS) as Array<[keyof OnePagerContent, number]>) {
    const value = out[field];
    if (typeof value !== "string" || wordCount(value) <= cap) continue;
    try {
      const res = await anthropic.messages.create({
        model: MODELS.drafting,
        max_tokens: 600,
        system: PREP_STYLE,
        messages: [{ role: "user", content: `Rewrite this one-pager section to at most ${Math.round(cap * 0.85)} words. Keep every fact, name, number, and date; cut filler, repetition, and commentary. Return only the rewritten paragraph.\n\n${value}` }],
      });
      const text = stripCites(res.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
      if (text && wordCount(text) < wordCount(value)) (out as Record<string, unknown>)[field] = text;
    } catch {
      /* keep the long version rather than fail the prep */
    }
  }
  return out;
}

const SECTION_KEYS: Record<string, keyof OnePagerContent> = {
  "company name": "companyName",
  "quick brief": "quickBrief",
  "business model": "businessModel",
  "relationship": "relationshipCatchUp",
  "what they do": "whatTheyDo",
  "customers": "customers",
  "company history": "companyHistory",
  "recent news": "recentNews",
};

/**
 * The model writes labelled sections, not JSON. A paragraph with a quote or a
 * line break inside it broke JSON often enough to ship half-empty preps; a
 * heading per section cannot break that way, and a missing section is visible
 * instead of silently empty.
 */
export function parseSections(raw: string): OnePagerContent {
  const text = stripCites(raw).replace(/\r/g, "");
  const headingRe = /^[ \t]*(?:#{1,4}[ \t]*|\*\*)?(COMPANY NAME|QUICK BRIEF|BUSINESS MODEL|RELATIONSHIP|WHAT THEY DO|CUSTOMERS|COMPANY HISTORY|RECENT NEWS)(?:\*\*)?[ \t]*:[ \t]*(?:\*\*)?[ \t]*/gim;
  const found: Array<{ key: keyof OnePagerContent; start: number; bodyStart: number }> = [];
  for (const m of text.matchAll(headingRe)) {
    const key = SECTION_KEYS[m[1].toLowerCase()];
    if (key && m.index !== undefined) found.push({ key, start: m.index, bodyStart: m.index + m[0].length });
  }
  const out: OnePagerContent = {
    companyName: "",
    generatedOn: new Date().toISOString(),
    quickBrief: "",
    businessModel: "",
    relationshipCatchUp: "",
    whatTheyDo: "",
    customers: "",
    companyHistory: "",
    recentNews: [],
  };
  found.forEach((section, idx) => {
    const end = idx + 1 < found.length ? found[idx + 1].start : text.length;
    const body = text.slice(section.bodyStart, end).trim();
    if (section.key === "recentNews") {
      out.recentNews = body
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter((line) => line && !/^(none|n\/a|not available|no (recent|reliable) news( found)?)\.?$/i.test(line));
    } else if (section.key !== "generatedOn") {
      out[section.key] = body.replace(/\n{2,}/g, "\n\n").replace(/[ \t]*\n[ \t]*/g, " ").trim();
    }
  });
  if (!out.companyName) out.companyName = "Unknown Company";
  return out;
}

/** Minimum words a section needs before a prep is allowed to save. */
const MIN_WORDS: Partial<Record<keyof OnePagerContent, number>> = {
  whatTheyDo: 40,
  customers: 60,
  companyHistory: 40,
};
const MIN_WORDS_RECONNECT: Partial<Record<keyof OnePagerContent, number>> = {
  ...MIN_WORDS,
  quickBrief: 30,
  businessModel: 20,
  relationshipCatchUp: 10,
};

/** Names of the sections that are missing or cut short; empty when the prep is complete. */
export function thinSections(content: OnePagerContent, prepMode: "first_call" | "reconnect"): string[] {
  const mins = prepMode === "reconnect" ? MIN_WORDS_RECONNECT : MIN_WORDS;
  const out: string[] = [];
  for (const [field, min] of Object.entries(mins) as Array<[keyof OnePagerContent, number]>) {
    const value = content[field];
    const words = typeof value === "string" ? wordCount(value) : 0;
    const allowedShort = typeof value === "string" && /^not available\.?$/i.test(value.trim()) && field !== "whatTheyDo";
    if (words < min && !allowedShort) out.push(field);
  }
  return out;
}

function sectionFormat(prepMode: "first_call" | "reconnect"): string {
  const headings = prepMode === "reconnect"
    ? ["COMPANY NAME", "QUICK BRIEF", "BUSINESS MODEL", "RELATIONSHIP", "WHAT THEY DO", "CUSTOMERS", "COMPANY HISTORY", "RECENT NEWS"]
    : ["COMPANY NAME", "WHAT THEY DO", "CUSTOMERS", "COMPANY HISTORY", "RECENT NEWS"];
  return `Write plain text with exactly these headings, each on its own line followed by a colon, in this order, with the section text under each. No JSON, no markdown, no other headings, nothing before the first heading or after the last section:\n${headings.map((h) => `${h}:`).join("\n")}\nUnder RECENT NEWS put one item per line starting with "- ", or the single word "None".`;
}

function applyPrepMode(
  content: OnePagerContent,
  prepMode: "first_call" | "reconnect",
): OnePagerContent {
  if (prepMode === "reconnect") return content;

  // First Calls use the established four-section format. These fields belong
  // only to Reconnect and must not leak into cached or downloaded First Calls.
  return {
    ...content,
    quickBrief: "",
    businessModel: "",
    relationshipCatchUp: "",
  };
}

export async function runPrepGenerate(
  input: PrepInput,
): Promise<OnePagerContent> {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    throw new Error("AI service not configured (missing ANTHROPIC_API_KEY)");
  }

  const companyIdentifier =
    input.accountName || input.domain || input.website || "Unknown";
  const prepMode = input.prepMode === "reconnect" ? "reconnect" : "first_call";

  // Step 1: Salesforce account context (if we have an accountId)
  let sfContext = "";
  if (input.accountId) {
    try {
      const [details, activities] = await Promise.all([
        fetchAccountDetails(input.accountId),
        fetchRecentAccountActivity(input.accountId),
      ]);
      if (details) {
        const parts: string[] = [];
        if (details.industry) parts.push(`Industry: ${details.industry}`);
        if (details.numberOfEmployees)
          parts.push(`Employees: ~${details.numberOfEmployees}`);
        if (details.billingCountry) {
          const loc = details.billingState
            ? `${details.billingState}, ${details.billingCountry}`
            : details.billingCountry;
          parts.push(`Location: ${loc}`);
        }
        if (details.yearEstablished)
          parts.push(`Year Established: ${details.yearEstablished}`);
        if (details.annualRevenue)
          parts.push(
            `Annual Revenue: $${details.annualRevenue.toLocaleString()}`,
          );
        if (details.ownership) parts.push(`Ownership: ${details.ownership}`);
        if (details.description)
          parts.push(`Description: ${details.description}`);

        if (parts.length > 0) {
          sfContext = `\n\nSalesforce Data:\n${parts.join("\n")}`;
        }
      }
      if (activities.length > 0) {
        sfContext += `\n\nRecent Salesforce relationship activity:\n${activities.join("\n")}`;
      }
    } catch {
      /* non-critical */
    }
  }

  // Step 2: Scrape website if we have a URL
  let scrapedContext = "";
  const siteUrl =
    input.website || (input.domain ? `https://${input.domain}` : null);
  if (siteUrl) {
    const scraped = await scrapeWebsite(siteUrl);
    if (scraped.length > 100) {
      scrapedContext = `\n\nWebsite Content (scraped):\n${scraped.slice(0, 6000)}`;
    }
  }

  // When the website scrape succeeds, use it (plus Salesforce) for the stable
  // business sections and enable live web search only for Recent News. This is
  // a quality-preserving split: Sonnet still writes every judgment-heavy
  // section; only unnecessary search-tool use is removed. If scraping fails,
  // the original full-search fallback below remains active.
  if (scrapedContext) {
    const targetCompany = input.accountName || siteUrl || "Unknown";
    const mode = prepMode === "reconnect" ? "Reconnect" : "First Call";
    const commonGuard = `Target company: ${targetCompany}\nWebsite: ${siteUrl ?? "Not available"}\nMeeting mode: ${mode}\n\nWrite about this exact company only. Never pivot to a parent, acquirer, investor, sister company, or namesake.`;
    const staticPrompt = prepMode === "reconnect" ? `${commonGuard}

Prepare the stable sections of an M&A call briefing from the supplied website and Salesforce evidence. The 60-second brief must refresh the reader on the business even for a reconnect. For Reconnect mode, RELATIONSHIP must summarize prior interactions, promises, objections, and the most useful reopening angle from Salesforce activity. Do not invent missing facts.
${sfContext}${scrapedContext}

${sectionFormat("reconnect")}

Section guidance: COMPANY NAME is the common short name. QUICK BRIEF is a genuinely useful 60-second read: business, business model, who buys, relationship status, and suggested call angle in 5 to 7 sentences. BUSINESS MODEL is 2 to 4 sentences on products, how it earns money, recurring versus project revenue where supported, and the likely buyer. RELATIONSHIP is 2 to 4 sentences based only on Salesforce history, or "Not available" if none was supplied. WHAT THEY DO, CUSTOMERS and COMPANY HISTORY follow the style rules. Leave RECENT NEWS as "None"; it is researched separately.` : `${commonGuard}

What does this company do, what type of companies would be customers, and give a use case example. Use everyday language that a non-industry expert can understand. Give me a one pager on the company and its history ahead of an M&A call.

Match the established First Call format and level of detail: four useful sections only, without a separate executive summary, business-model section, relationship section, suggested call angle, or repeated information. Use the supplied website and Salesforce evidence and do not invent missing facts.
${sfContext}${scrapedContext}

${sectionFormat("first_call")}

Section guidance: WHAT THEY DO is one plain-language paragraph, 70 to 120 words. CUSTOMERS is one paragraph on who buys and why (60 to 100 words) followed by the worked "For example, ..." scene (60 to 100 words) from the style rules. COMPANY HISTORY is one paragraph on founding, headquarters, leadership, milestones, ownership, and M&A where supported, 90 to 150 words. Leave RECENT NEWS as "None"; it is researched separately.`;
    const newsPrompt = `${commonGuard}

Use web search to find 2-3 genuinely relevant recent news items about this exact company: product releases, material announcements, partnerships, funding, leadership, or acquisitions. Prefer the last 18 months, attach an approximate month/year, and do not substitute news about a similarly named company.

Answer with the heading "RECENT NEWS:" on its own line, then one item per line starting with "- " (one sentence each, month and year included), or the single word "None" if nothing reliable was found. Nothing else.`;
    const [stable, newsMessage] = await Promise.all([
      generateSections(anthropic, staticPrompt, prepMode, false),
      anthropic.messages.create({
        model: MODELS.drafting,
        max_tokens: 1536,
        system: PREP_STYLE,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: newsPrompt }],
      }),
    ]);
    const newsText = newsMessage.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("\n");
    const recentNews = parseSections(newsText.includes("RECENT NEWS") ? newsText : `RECENT NEWS:\n${newsText}`).recentNews;
    return applyPrepMode(
      await tightenSections(anthropic, { ...stable, generatedOn: new Date().toISOString(), recentNews }),
      prepMode,
    );
  }

  // Step 3: Build prompt
  // The TARGET is the company the user selected (manual link or auto-match).
  // We anchor the prompt on that name explicitly so the model does NOT pivot to
  // a parent / acquirer / investor / sister company that may appear in the
  // Salesforce description or the scraped page (the real bug that produced a
  // "Valstone Corporation" one-pager for a meeting linked to WMC Technologies).
  const targetCompany = input.accountName || siteUrl || "Unknown";
  const prompt = `Target company: ${targetCompany}${
    siteUrl ? `\nWebsite: ${siteUrl}` : ""
  }

You MUST write the one-pager about THIS exact target company. If the Salesforce data, the website, the scraped content, or any web search result references a different entity — a parent company, acquirer, investor, sister/portfolio company, or unrelated namesake — do NOT pivot to writing about them. They are NOT the subject. If you genuinely cannot find information about the target company, fill the fields with "Not available" rather than substituting another company.

What does this company do, what type of companies would be customers, and give a use case example. Use everyday language that a non-industry expert can understand. Give me a one pager on the company and its history ahead of an M&A call.

Also include 2-3 relevant recent news items about this company (new product releases, big announcements, partnerships, funding rounds, etc.).
${prepMode === "first_call" ? "\nFor a First Call, match the established concise four-section format only: What They Do, Customers & Use Case, Company History, and Recent News. Do not add or repeat an executive summary, business-model section, relationship section, or suggested call angle. Keep each of the first three sections to one tight paragraph like the established call-prep documents." : "\nFor a Reconnect, include the 60-second refresher, business model, and relationship catch-up in addition to the four core sections."}
${sfContext}${scrapedContext}${
    !scrapedContext && !sfContext
      ? "\n\nNo website or Salesforce data is available. Use web search to find information about this company."
      : scrapedContext
        ? "\n\nIf the scraped content is missing key information, use web search to supplement."
        : "\n\nNo website could be scraped. Use web search to find additional information."
  }

${sectionFormat(prepMode)}

Section guidance: ${prepMode === "reconnect" ? "QUICK BRIEF is a 60-second refresher covering the business, business model, buyer, relationship status, and useful call angle. BUSINESS MODEL is 2 to 4 sentences on products, how the company earns money, and who pays. RELATIONSHIP is 2 to 4 sentences based on Salesforce activity, or \"Not available\" when there is none. " : ""}WHAT THEY DO is one plain-language paragraph on what the TARGET company does, 70 to 120 words. CUSTOMERS is one paragraph on who buys from the TARGET company and why (60 to 100 words) followed by the worked "For example, ..." scene (60 to 100 words) from the style rules. COMPANY HISTORY is one paragraph on founding, headquarters, leadership, milestones, ownership, and M&A where supported, 90 to 150 words. RECENT NEWS: 2 to 3 items, one per line, month and year included.`;

  // Step 4: one model call with web search, parsed by heading and checked for completeness.
  const parsed = await generateSections(anthropic, prompt, prepMode, true);
  return applyPrepMode(await tightenSections(anthropic, parsed), prepMode);
}

/**
 * Ask for the sections, check every required one has real text, and ask once
 * more naming the thin ones if not. A prep that is still incomplete fails here,
 * loudly, rather than saving with blank sections.
 */
async function generateSections(
  anthropic: NonNullable<ReturnType<typeof getAnthropicClient>>,
  prompt: string,
  prepMode: "first_call" | "reconnect",
  withSearch: boolean,
): Promise<OnePagerContent> {
  const ask = async (extra: string) => {
    const res = await anthropic.messages.create({
      model: MODELS.drafting,
      max_tokens: 4096,
      system: PREP_STYLE,
      ...(withSearch ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 5 }] } : {}),
      messages: [{ role: "user", content: extra ? `${prompt}\n\n${extra}` : prompt }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    return { text, parsed: parseSections(text), stop: res.stop_reason };
  };
  let attempt = await ask("");
  let thin = thinSections(attempt.parsed, prepMode);
  if (thin.length > 0) {
    console.warn(`[prep] thin sections on first try (${thin.join(", ")}; stop=${attempt.stop}): ${attempt.text.slice(0, 300).replace(/\s+/g, " ")}`);
    attempt = await ask(`Your previous answer was incomplete: ${thin.join(", ")} ${thin.length === 1 ? "was" : "were"} missing or cut short. Write the complete answer with every section filled in full.`);
    thin = thinSections(attempt.parsed, prepMode);
  }
  if (thin.length > 0) {
    throw new Error(`The one-pager came back incomplete (${thin.join(", ")}). Try again; if it repeats, the website gave too little to work with.`);
  }
  return attempt.parsed;
}
