import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import { fetchAccountDetails } from "@/lib/salesforce-prep";

// ── Types ────────────────────────────────────────────────────────────────────

export type OnePagerContent = {
  companyName: string;
  whatTheyDo: string;
  customers: string;
  companyHistory: string;
  recentNews: string[];
};

// ── Website scraping via Jina AI Reader (same pattern as lib/enrichment.ts) ──

async function fetchPageText(
  url: string,
  timeoutMs = 10000
): Promise<string | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/plain" },
    });
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

  const results: string[] = [];
  let totalChars = 0;
  const MAX_CHARS = 10000;

  for (const pageUrl of pages) {
    if (totalChars >= MAX_CHARS) break;
    const text = await fetchPageText(pageUrl, 8000);
    if (text && text.length > 100) {
      const trimmed = text.slice(0, MAX_CHARS - totalChars);
      results.push(`--- Page: ${pageUrl} ---\n${trimmed}`);
      totalChars += trimmed.length;
    }
  }

  return results.join("\n\n");
}

// ── JSON extraction helper ───────────────────────────────────────────────────

function parseOnePagerJson(raw: string): OnePagerContent | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      companyName: parsed.companyName || "Unknown Company",
      whatTheyDo: parsed.whatTheyDo || "",
      customers: parsed.customers || "",
      companyHistory: parsed.companyHistory || "",
      recentNews: Array.isArray(parsed.recentNews) ? parsed.recentNews : [],
    };
  } catch {
    return null;
  }
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return NextResponse.json(
      { error: "AI service not configured (missing ANTHROPIC_API_KEY)" },
      { status: 500 }
    );
  }

  const body = await request.json();
  const { accountId, accountName, website, domain } = body as {
    accountId?: string;
    accountName?: string;
    website?: string;
    domain?: string;
  };

  // We need at least a company name or domain to work with
  const companyIdentifier = accountName || domain || website || "Unknown";

  try {
    // Step 1: Fetch Salesforce account details (if we have an accountId)
    let sfContext = "";
    if (accountId) {
      try {
        const details = await fetchAccountDetails(accountId);
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
            parts.push(`Annual Revenue: $${details.annualRevenue.toLocaleString()}`);
          if (details.ownership) parts.push(`Ownership: ${details.ownership}`);
          if (details.description)
            parts.push(`Description: ${details.description}`);

          if (parts.length > 0) {
            sfContext = `\n\nSalesforce Data:\n${parts.join("\n")}`;
          }
        }
      } catch {
        // Non-critical — proceed without Salesforce data
      }
    }

    // Step 2: Scrape the company website (if we have a URL)
    let scrapedContext = "";
    const siteUrl = website || (domain ? `https://${domain}` : null);
    if (siteUrl) {
      const scraped = await scrapeWebsite(siteUrl);
      if (scraped.length > 100) {
        scrapedContext = `\n\nWebsite Content (scraped):\n${scraped.slice(0, 6000)}`;
      }
    }

    // Step 3: Build the prompt
    const prompt = `${siteUrl || companyIdentifier}

What does this company do, what type of companies would be customers, and give a use case example. Use everyday language that a non-industry expert can understand. Give me a one pager on the company and its history ahead of an M&A call.

Also include 2-3 relevant recent news items about this company (new product releases, big announcements, partnerships, funding rounds, etc.).
${sfContext}${scrapedContext}${
      !scrapedContext && !sfContext
        ? "\n\nNo website or Salesforce data is available. Use web search to find information about this company."
        : scrapedContext
          ? "\n\nIf the scraped content is missing key information, use web search to supplement."
          : "\n\nNo website could be scraped. Use web search to find additional information."
    }

Return ONLY valid JSON, no explanation, no markdown fences. Use this exact structure:
{
  "companyName": "The company's common/short name",
  "whatTheyDo": "2-4 sentences in plain language explaining what the company does. A non-industry expert should be able to understand.",
  "customers": "2-4 sentences describing what types of companies are their customers, followed by a concrete use case example. Start the use case with 'For example, ...'",
  "companyHistory": "3-5 sentences covering when the company was founded, key milestones, leadership, growth, and any M&A activity (acquisitions made or investment received).",
  "recentNews": ["News item 1 — brief description with approximate date", "News item 2 — brief description with approximate date", "News item 3 — brief description with approximate date"]
}`;

    // Step 4: Call Claude with web search enabled
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ];

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      tools,
      messages: [{ role: "user", content: prompt }],
    });

    // Find the last text block (web search responses have multiple content blocks)
    const textBlocks = message.content.filter((b) => b.type === "text");
    if (textBlocks.length === 0) {
      return NextResponse.json(
        { error: "AI returned no text response" },
        { status: 500 }
      );
    }

    const lastText = textBlocks[textBlocks.length - 1];
    const responseText = lastText.type === "text" ? lastText.text.trim() : "";

    const parsed = parseOnePagerJson(responseText);
    if (!parsed) {
      return NextResponse.json(
        { error: "Failed to parse AI response" },
        { status: 500 }
      );
    }

    return NextResponse.json({ onePager: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
