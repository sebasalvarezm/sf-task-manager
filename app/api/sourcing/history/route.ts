import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  getWaybackCandidates,
  fetchWaybackSnapshot,
  extractProducts,
  findDiscontinued,
} from "@/lib/scout";

export const maxDuration = 55;

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return NextResponse.json(
      { error: "AI service not configured" },
      { status: 500 }
    );
  }

  const { url, foundingYear, currentProducts } = (await request.json()) as {
    url: string;
    foundingYear: number | null;
    currentProducts: string[];
  };

  if (!url) {
    return NextResponse.json({ error: "Missing URL" }, { status: 400 });
  }

  try {
    // Determine Wayback Machine date range based on founding year
    let wbFrom: string;
    let wbTo: string;
    let wbLabel: string;

    if (foundingYear && foundingYear >= 2010) {
      wbFrom = `${foundingYear}0101`;
      wbTo = `${foundingYear + 2}1231`;
      wbLabel = `${foundingYear}–${foundingYear + 2}`;
    } else if (foundingYear) {
      wbFrom = "20060101";
      wbTo = "20101231";
      wbLabel = "2006–2010";
    } else {
      wbFrom = "20060101";
      wbTo = "20201231";
      wbLabel = "2006–2020";
    }

    // Query Wayback Machine for historical snapshots
    const candidates = await getWaybackCandidates(url, wbFrom, wbTo);

    if (candidates.length === 0) {
      return NextResponse.json({
        archiveUrl: null,
        archiveYear: null,
        wbLabel,
        discontinued: null,
        discontinuedNote: null,
        oldProducts: [],
      });
    }

    // Extract the domain stem for validation
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    const domainStem = parsed.hostname
      .replace("www.", "")
      .split(".")[0]
      .toLowerCase();

    // Try each candidate until we find a valid one
    let archiveUrl: string | null = null;
    let archiveTimestamp: string | null = null;
    let oldText: string | null = null;

    for (const candidate of candidates) {
      const text = await fetchWaybackSnapshot(candidate.url, domainStem);
      if (text) {
        archiveUrl = candidate.url;
        archiveTimestamp = candidate.timestamp;
        oldText = text;
        break;
      }
    }

    if (!archiveUrl || !oldText) {
      return NextResponse.json({
        archiveUrl: null,
        archiveYear: null,
        wbLabel,
        discontinued: null,
        discontinuedNote: null,
        oldProducts: [],
      });
    }

    const archiveYear = archiveTimestamp!.slice(0, 4);

    // Extract products from the archived version
    const oldProducts = await extractProducts(
      anthropic,
      oldText,
      `archived (${archiveYear})`
    );

    // Compare product lines to find discontinued items
    let discontinued: string | null = null;
    let discontinuedNote: string | null = null;

    if (oldProducts.length > 0 && currentProducts.length > 0) {
      discontinued = await findDiscontinued(
        anthropic,
        oldProducts,
        currentProducts,
        wbLabel
      );
      if (discontinued) {
        discontinuedNote = `Found on the ${archiveYear} archived version of the site (Wayback Machine, ${wbLabel} window).`;
      }
    }

    return NextResponse.json({
      archiveUrl,
      archiveYear,
      wbLabel,
      discontinued,
      discontinuedNote,
      oldProducts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
