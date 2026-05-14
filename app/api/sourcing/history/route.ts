import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  getWaybackCandidates,
  getInteriorCandidates,
  fetchWaybackSnapshot,
  extractProducts,
  extractNewsProducts,
  findDiscontinued,
} from "@/lib/scout";

export const maxDuration = 55;

/** Deduplicate a string array case-insensitively, preserving first occurrence. */
function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(item.trim());
    }
  }
  return result;
}

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
      wbTo = `${foundingYear + 5}1231`;
      wbLabel = `${foundingYear}\u2013${foundingYear + 5}`;
    } else if (foundingYear) {
      wbFrom = "20050101";
      wbTo = "20151231";
      wbLabel = "2005\u20132015";
    } else {
      wbFrom = "20060101";
      wbTo = "20201231";
      wbLabel = "2006\u20132020";
    }

    // Query Wayback Machine for historical snapshots
    logs.push(`Fetching Wayback Machine snapshots from ${wbLabel}...`);
    const { candidates } = await getWaybackCandidates(url, wbFrom, wbTo);

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
    const domainOnly = parsed.hostname.replace("www.", "");

    // Check up to 3 valid homepage snapshots and combine products from all
    let archiveUrl: string | null = null;
    let archiveTimestamp: string | null = null;
    let oldText: string | null = null;
    const allOldProducts: string[] = [];
    let validCount = 0;

    for (const candidate of candidates) {
      if (validCount >= 3) break;
      const year = candidate.timestamp.slice(0, 4);
      const result = await fetchWaybackSnapshot(candidate.url, domainStem);

      if (result.skipReason) {
        logs.push(`Skipping ${year} snapshot \u2014 ${result.skipReason}.`);
        continue;
      }

      if (result.text) {
        // Use the first valid snapshot as the canonical archive URL
        if (!archiveUrl) {
          archiveUrl = candidate.url;
          archiveTimestamp = candidate.timestamp;
          oldText = result.text;
        }

        logs.push(`Valid snapshot found from ${year}.`);

        // Extract products from this snapshot
        const products = await extractProducts(
          anthropic,
          result.text,
          `archived (${year})`
        );
        if (products.length > 0) {
          allOldProducts.push(...products);
          const preview = products.slice(0, 5).join(", ");
          const suffix = products.length > 5 ? "..." : "";
          logs.push(`Found ${products.length} product(s) in ${year} snapshot: ${preview}${suffix}`);
        }

        validCount++;
      }
    }

    // Probe archived interior pages (e.g. /products, /solutions, /services)
    // This finds product-rich pages that homepages often don't show
    const interiorKeywords = ["product", "solution", "service", "platform", "software"];
    let interiorChecked = 0;

    for (const keyword of interiorKeywords) {
      if (interiorChecked >= 3) break;

      const interiorCands = await getInteriorCandidates(
        domainOnly,
        keyword,
        wbFrom,
        wbTo,
        1
      );

      for (const ic of interiorCands) {
        if (interiorChecked >= 3) break;
        const icYear = ic.timestamp.slice(0, 4);

        const icResult = await fetchWaybackSnapshot(ic.url, domainStem);
        if (icResult.skipReason || !icResult.text) continue;

        logs.push(`Interior page snapshot (/${keyword}*, ${icYear}).`);
        const icProducts = await extractProducts(
          anthropic,
          icResult.text,
          `archived (${icYear}) interior`
        );
        if (icProducts.length > 0) {
          allOldProducts.push(...icProducts);
          const preview = icProducts.slice(0, 5).join(", ");
          const suffix = icProducts.length > 5 ? "..." : "";
          logs.push(`Found ${icProducts.length} product(s) on /${keyword}*: ${preview}${suffix}`);
        }
        interiorChecked++;
        break; // One snapshot per keyword is enough
      }
    }

    // Fallback: probe archived news/press/blog pages if not enough products found
    if (allOldProducts.length < 3 && archiveUrl) {
      logs.push("Not enough products found \u2014 checking news/press pages...");
      const newsKeywords = ["news", "press", "blog", "media", "announcements"];
      let newsChecked = 0;

      for (const keyword of newsKeywords) {
        if (newsChecked >= 2) break;

        const newsCands = await getInteriorCandidates(
          domainOnly,
          keyword,
          wbFrom,
          wbTo,
          1
        );

        for (const nc of newsCands) {
          if (newsChecked >= 2) break;
          const ncYear = nc.timestamp.slice(0, 4);

          const ncResult = await fetchWaybackSnapshot(nc.url, domainStem);
          if (ncResult.skipReason || !ncResult.text) continue;

          logs.push(`News page snapshot (/${keyword}*, ${ncYear}).`);
          const ncProducts = await extractNewsProducts(
            anthropic,
            ncResult.text,
            ncYear
          );
          if (ncProducts.length > 0) {
            allOldProducts.push(...ncProducts);
            const preview = ncProducts.slice(0, 5).join(", ");
            const suffix = ncProducts.length > 5 ? "..." : "";
            logs.push(`Found ${ncProducts.length} product(s) in news/press: ${preview}${suffix}`);
          }
          newsChecked++;
          break; // One snapshot per keyword is enough
        }
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

    // Deduplicate the combined pool of old products (case-insensitive)
    const oldProducts = dedup(allOldProducts);

    if (oldProducts.length > 0) {
      const preview = oldProducts.slice(0, 5).join(", ");
      const suffix = oldProducts.length > 5 ? "..." : "";
      logs.push(`Total unique archived products: ${oldProducts.length} \u2014 ${preview}${suffix}`);
    } else {
      logs.push("No products/services found across all archived snapshots.");
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
