import { getAnthropicClient, MODELS, stripCites } from "@/lib/anthropic";
import { fetchAccountDetails, fetchRecentAccountActivity } from "@/lib/salesforce-prep";

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

async function fetchPageText(
  url: string,
  timeoutMs = 10000,
): Promise<string | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "text/plain",
        ...(process.env.JINA_API_KEY ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` } : {}),
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

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

Length is a hard limit, not a target: whatTheyDo 70 to 120 words; customers 70 to 120 words including the "For example, ..." sentence; companyHistory 90 to 150 words; quickBrief 5 to 7 sentences; businessModel and relationshipCatchUp at most 80 words each; each recentNews item one sentence under 30 words with a month and year.`;

/** Word caps the code enforces after the model answers. */
const WORD_CAPS: Partial<Record<keyof OnePagerContent, number>> = {
  whatTheyDo: 130,
  customers: 130,
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

function tryParse(text: string): OnePagerContent | null {
  try {
    const obj = JSON.parse(text);
    for (const k of Object.keys(obj)) if (typeof obj[k] === "string") obj[k] = stripCites(obj[k]);
    return {
      companyName: obj.companyName || "Unknown Company",
      generatedOn: obj.generatedOn || new Date().toISOString(),
      quickBrief: obj.quickBrief || obj.whatTheyDo || "",
      businessModel: obj.businessModel || "Not available",
      relationshipCatchUp: obj.relationshipCatchUp || "No Salesforce relationship history available.",
      whatTheyDo: obj.whatTheyDo || "",
      customers: obj.customers || "",
      companyHistory: obj.companyHistory || "",
      recentNews: Array.isArray(obj.recentNews) ? obj.recentNews.map((x: unknown) => (typeof x === "string" ? stripCites(x) : x)) : [],
    };
  } catch {
    return null;
  }
}

function parseOnePagerJson(raw: string): OnePagerContent | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let parsed = tryParse(cleaned);
  if (parsed) return parsed;

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch) {
    parsed = tryParse(fenceMatch[1].trim());
    if (parsed) return parsed;
  }

  const braceMatch = raw.match(/\{[\s\S]*"companyName"[\s\S]*\}/);
  if (braceMatch) {
    parsed = tryParse(braceMatch[0]);
    if (parsed) return parsed;
  }

  return null;
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

Prepare the stable sections of an M&A call briefing from the supplied website and Salesforce evidence. The 60-second brief must refresh the reader on the business even for a reconnect. For Reconnect mode, relationshipCatchUp must summarize prior interactions, promises, objections, and the most useful reopening angle from Salesforce activity. Do not invent missing facts.
${sfContext}${scrapedContext}

Return ONLY valid JSON:
{
  "companyName": "common short name",
  "quickBrief": "A genuinely useful 60-second read: business, business model, who buys, relationship status, and suggested call angle in 5-7 concise sentences",
  "businessModel": "2-4 sentences on products/services, how it earns money, recurring versus project revenue where supported, and likely buyer/customer",
  "relationshipCatchUp": "2-4 sentences based only on Salesforce history; say no history is available if none was supplied",
  "whatTheyDo": "2-4 plain-language sentences",
  "customers": "2-4 sentences including a concrete example beginning 'For example, ...'",
  "companyHistory": "3-5 sentences covering founding, milestones, leadership, growth, and M&A where supported",
  "recentNews": []
}` : `${commonGuard}

What does this company do, what type of companies would be customers, and give a use case example. Use everyday language that a non-industry expert can understand. Give me a one pager on the company and its history ahead of an M&A call.

Match the established First Call format and level of detail: four useful sections only, without a separate executive summary, business-model section, relationship section, suggested call angle, or repeated information. Use the supplied website and Salesforce evidence and do not invent missing facts.
${sfContext}${scrapedContext}

Return ONLY valid JSON:
{
  "companyName": "The common/short name of the target company",
  "whatTheyDo": "One plain-language paragraph on what the company does, 70 to 120 words",
  "customers": "One paragraph on who buys and why, ending with a concrete use case beginning 'For example, ...', 70 to 120 words",
  "companyHistory": "One paragraph on founding, headquarters, leadership, milestones, ownership, and M&A where supported, 90 to 150 words",
  "recentNews": []
}`;
    const newsPrompt = `${commonGuard}

Use web search to find 2-3 genuinely relevant recent news items about this exact company: product releases, material announcements, partnerships, funding, leadership, or acquisitions. Prefer the last 18 months, attach an approximate month/year, and do not substitute news about a similarly named company. If nothing reliable is found, return an empty list.

Return ONLY valid JSON: {"recentNews":["item 1", "item 2"]}`;
    const [staticMessage, newsMessage] = await Promise.all([
      anthropic.messages.create({
        model: MODELS.drafting,
        max_tokens: 3072,
        system: PREP_STYLE,
        messages: [{ role: "user", content: staticPrompt }],
      }),
      anthropic.messages.create({
        model: MODELS.drafting,
        max_tokens: 1536,
        system: PREP_STYLE,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: newsPrompt }],
      }),
    ]);
    const staticText = staticMessage.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("\n");
    const newsText = newsMessage.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("\n");
    const stable = parseOnePagerJson(staticText);
    if (!stable) throw new Error("Failed to parse AI briefing sections");
    let recentNews: string[] = [];
    try {
      const json = newsText.match(/\{[\s\S]*\}/)?.[0] ?? newsText;
      const parsed = JSON.parse(json) as { recentNews?: unknown };
      if (Array.isArray(parsed.recentNews)) recentNews = parsed.recentNews.filter((x): x is string => typeof x === "string").map(stripCites);
    } catch {
      throw new Error("Failed to parse recent news response");
    }
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

Return ONLY valid JSON, no explanation, no markdown fences. Use this exact structure:
{
  "companyName": "The common/short name of the target company (must be the target, not a parent/acquirer)",
  "quickBrief": "${prepMode === "reconnect" ? "A 60-second refresher covering the business, business model, buyer, relationship status, and useful call angle" : ""}",
  "businessModel": "${prepMode === "reconnect" ? "2-4 sentences explaining products/services, how the company earns money, and who pays" : ""}",
  "relationshipCatchUp": "${prepMode === "reconnect" ? "2-4 sentences based on Salesforce relationship activity; explicitly say when no history is available" : ""}",
  "whatTheyDo": "One plain-language paragraph on what the TARGET company does, 70 to 120 words.",
  "customers": "One paragraph on who buys from the TARGET company and why, ending with a concrete use case beginning 'For example, ...', 70 to 120 words",
  "companyHistory": "One paragraph on when the TARGET company was founded, headquarters, leadership, milestones, ownership, and M&A where supported, 90 to 150 words.",
  "recentNews": ["News item 1 about the target, one sentence with month and year", "News item 2", "News item 3"]
}`;

  // Step 4: Claude with web search enabled
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  ];

  const message = await anthropic.messages.create({
    model: MODELS.drafting,
    max_tokens: 4096,
    system: PREP_STYLE,
    tools,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlocks = message.content.filter((b) => b.type === "text");
  if (textBlocks.length === 0) {
    throw new Error("AI returned no text response");
  }

  const lastText = textBlocks[textBlocks.length - 1];
  const responseText = lastText.type === "text" ? stripCites(lastText.text) : "";

  const parsed = parseOnePagerJson(responseText);
  if (!parsed) {
    throw new Error("Failed to parse AI response");
  }

  return applyPrepMode(await tightenSections(anthropic, parsed), prepMode);
}
