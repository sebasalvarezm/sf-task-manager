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

  const logs: string[] = [];

  try {
    // Determine Wayback Machine date range based on founding year
    let wbFrom: string;
    let wbTo: string;
    let wbLabel: string;

    if (foundingYear && foundingYear >= 2010) {
      wbFrom = `${foundingYear}0101`;
      wbTo = `${foundingYear + 2}1231`;
      wbLabel = `${foundingYear}\u2013${foundingYear + 2}`;
    } else if (foundingYear) {
      wbFrom = "20060101";
      wbTo = "20101231";
      wbLabel = "2006\u20132010";
    } else {
      wbFrom = "20060101";
      wbTo = "20201231";
      wbLabel = "2006\u20132020";
    }

    // Query Wayback Machine for historical snapshots
    logs.push(`Fetching Wayback Machine snapshots from ${wbLabel}...`);
    const candidates = await getWaybackCandidates(url, wbFrom, wbTo);

    if (candidates.length === 0) {
      logs.push("No archived snapshots found in that date range.");
      return NextResponse.json({
        archiveUrl: null,
        archiveYear: null,
        wbLabel,
        discontinued: null,
        discontinuedNote: null,
        oldProducts: [],
        logs,
      });
    }

    logs.push(`Found ${candidates.length} candidate snapshot(s) \u2014 checking each...`);

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
      const year = candidate.timestamp.slice(0, 4);
      const result = await fetchWaybackSnapshot(candidate.url, domainStem);

      if (result.skipReason) {
        logs.push(`Skipping ${year} snapshot \u2014 ${result.skipReason}.`);
        continue;
      }

      if (result.text) {
        archiveUrl = candidate.url;
        archiveTimestamp = candidate.timestamp;
        oldText = result.text;
        logs.push(`Valid snapshot found from ${year}.`);
        break;
      }
    }

    if (!archiveUrl || !oldText) {
      logs.push("No valid snapshot passed all checks.");
      return NextResponse.json({
        archiveUrl: null,
        archiveYear: null,
        wbLabel,
        discontinued: null,
        discontinuedNote: null,
        oldProducts: [],
        logs,
      });
    }

    const archiveYear = archiveTimestamp!.slice(0, 4);
    logs.push(`Extracted ${oldText.length.toLocaleString()} characters from the archived page.`);

    // Extract products from the archived version
    logs.push("Extracting archived products and services...");
    const oldProducts = await extractProducts(
      anthropic,
      oldText,
      `archived (${archiveYear})`
    );

    if (oldProducts.length > 0) {
      const preview = oldProducts.slice(0, 5).join(", ");
      const suffix = oldProducts.length > 5 ? "..." : "";
      logs.push(`Found ${oldProducts.length} archived product(s): ${preview}${suffix}`);
    } else {
      logs.push("No named products/services found in the archived page.");
    }

    // Compare product lines to find discontinued items
    logs.push("Comparing product lines...");
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
        logs.push(`Discontinued item identified: ${discontinued}`);
      } else {
        logs.push("No discontinued items identified.");
      }
    } else {
      logs.push("Skipping comparison \u2014 not enough product data from one or both versions.");
    }

    return NextResponse.json({
      archiveUrl,
      archiveYear,
      wbLabel,
      discontinued,
      discontinuedNote,
      oldProducts,
      logs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message, logs }, { status: 500 });
  }
}
