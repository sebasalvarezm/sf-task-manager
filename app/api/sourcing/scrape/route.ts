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

  try {
    // Step 1: Scrape current website
    const currentText = await scrapeWithJina(normalized);

    if (!currentText || currentText.length < 100) {
      return NextResponse.json(
        {
          error:
            "Could not extract any text from this site. It may require a login, block web scrapers, or be built entirely in JavaScript.",
        },
        { status: 400 }
      );
    }

    if (isParkedPage(currentText)) {
      return NextResponse.json(
        { error: "This domain appears to be parked or a placeholder page." },
        { status: 400 }
      );
    }

    // Step 2: Extract products (runs in parallel with founding year + portfolio match)
    const [products, copyrightYear, claudeYear, waybackYear, groups] =
      await Promise.all([
        extractProducts(anthropic, currentText, "current"),
        Promise.resolve(extractCopyrightYear(currentText)),
        detectFoundingYear(anthropic, currentText),
        getEarliestSnapshotYear(normalized),
        Promise.resolve(loadGroupFiles()),
      ]);

    // Determine founding year from all sources (take the minimum)
    const yearCandidates: number[] = [];
    if (copyrightYear) yearCandidates.push(copyrightYear);
    if (claudeYear) yearCandidates.push(claudeYear);
    if (waybackYear) yearCandidates.push(waybackYear);

    // Try web search if other sources yielded nothing
    let foundingYear: number | null = null;
    if (yearCandidates.length > 0) {
      foundingYear = Math.min(...yearCandidates);
    } else {
      const webYear = await searchFoundingYearWeb(anthropic, normalized);
      if (webYear) foundingYear = webYear;
    }

    // Step 3: Portfolio match
    const portfolioMatch = await matchGroup(anthropic, currentText, groups);

    return NextResponse.json({
      currentText,
      products,
      foundingYear,
      portfolioMatch,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
