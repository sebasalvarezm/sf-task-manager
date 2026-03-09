import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  scrapeWithJina,
  isParkedPage,
  extractProducts,
  extractCopyrightYear,
  detectFoundingYear,
  getEarliestSnapshotYear,
  searchFoundingYearWeb,
  loadGroupFiles,
  matchGroup,
} from "@/lib/scout";

export const maxDuration = 55;

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

  const { url } = (await request.json()) as { url: string };
  if (!url) {
    return NextResponse.json({ error: "Missing URL" }, { status: 400 });
  }

  const normalized = url.startsWith("http") ? url : `https://${url}`;
  const logs: string[] = [];

  try {
    // Step 1: Scrape current website
    logs.push("Scraping current website...");
    const currentText = await scrapeWithJina(normalized);

    if (!currentText || currentText.length < 100) {
      return NextResponse.json(
        {
          error:
            "Could not extract any text from this site. It may require a login, block web scrapers, or be built entirely in JavaScript.",
          logs,
        },
        { status: 400 }
      );
    }

    if (isParkedPage(currentText)) {
      return NextResponse.json(
        { error: "This domain appears to be parked or a placeholder page.", logs },
        { status: 400 }
      );
    }

    logs.push(`Extracted ${currentText.length.toLocaleString()} characters.`);

    // Step 2: Extract products + founding year + portfolio groups (in parallel)
    logs.push("Extracting current products and services...");

    const [products, copyrightYear, claudeYear, waybackYear, groups] =
      await Promise.all([
        extractProducts(anthropic, currentText, "current"),
        Promise.resolve(extractCopyrightYear(currentText)),
        detectFoundingYear(anthropic, currentText),
        getEarliestSnapshotYear(normalized),
        Promise.resolve(loadGroupFiles()),
      ]);

    // Log products
    if (products.length > 0) {
      const preview = products.slice(0, 5).join(", ");
      const suffix = products.length > 5 ? "..." : "";
      logs.push(`Found ${products.length} product(s): ${preview}${suffix}`);
    } else {
      logs.push("No named products/services found on the current site.");
    }

    // Determine founding year from all sources (take the minimum)
    logs.push("Detecting company founding year...");
    const yearCandidates: { source: string; year: number }[] = [];
    if (copyrightYear) yearCandidates.push({ source: "copyright footer", year: copyrightYear });
    if (claudeYear) yearCandidates.push({ source: "page text", year: claudeYear });
    if (waybackYear) yearCandidates.push({ source: "earliest web archive", year: waybackYear });

    let foundingYear: number | null = null;
    if (yearCandidates.length > 0) {
      const best = yearCandidates.reduce((a, b) => (a.year < b.year ? a : b));
      foundingYear = best.year;
      logs.push(`Founding year: ${best.year} (from ${best.source})`);
    } else {
      // Try web search as fallback
      logs.push("No founding year from page — searching the web...");
      const webYear = await searchFoundingYearWeb(anthropic, normalized);
      if (webYear) {
        foundingYear = webYear;
        logs.push(`Founding year: ${webYear} (from web search)`);
      } else {
        logs.push("Founding year not found — using wide Wayback Machine window.");
      }
    }

    // Step 3: Portfolio match
    logs.push(`Loaded ${Object.keys(groups).length} portfolio group file(s).`);
    logs.push("Matching to portfolio group...");
    const portfolioMatch = await matchGroup(anthropic, currentText, groups);

    if (portfolioMatch.matched) {
      logs.push(`Best match: ${portfolioMatch.group}`);
    } else {
      logs.push("No portfolio group is a strong fit for this company.");
    }

    return NextResponse.json({
      currentText,
      products,
      foundingYear,
      portfolioMatch,
      logs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message, logs }, { status: 500 });
  }
}
