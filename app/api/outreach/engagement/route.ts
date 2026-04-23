import { NextResponse, NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  fetchMailingsWithEngagement,
  fetchProspectsByIds,
} from "@/lib/outreach-engagements";
import {
  computeHeatmap,
  computeMultiOpens,
  enrichMultiOpens,
} from "@/lib/analytics-derivations";

// Returns heatmap + multi-open card data for the given date range.
// Uses only the /mailings endpoint (which carries openCount/replyCount
// on each record), so no events.read scope is needed.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Missing start or end query parameter" },
      { status: 400 }
    );
  }

  try {
    const mailings = await fetchMailingsWithEngagement(start, end);

    const heatmap = computeHeatmap(mailings);
    const multiRaw = computeMultiOpens(mailings);

    // Resolve prospect details for only the top 20 multi-openers.
    const top = multiRaw.slice(0, 20);
    const prospectInfo = await fetchProspectsByIds(top.map((m) => m.prospectId));
    const multiOpens = enrichMultiOpens(top, prospectInfo);

    return NextResponse.json({
      heatmap,
      multiOpens,
      totals: {
        mailings: mailings.length,
        multiOpenCount: multiRaw.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (message === "OUTREACH_NOT_CONNECTED") {
      return NextResponse.json(
        { error: "OUTREACH_NOT_CONNECTED" },
        { status: 403 }
      );
    }

    console.error("engagement route error:", message);
    return NextResponse.json(
      { error: `Outreach error: ${message}` },
      { status: 500 }
    );
  }
}
