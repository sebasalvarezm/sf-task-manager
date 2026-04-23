import { NextResponse, NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  fetchSendEvents,
  fetchOpenAndReplyEvents,
  fetchProspectsByIds,
} from "@/lib/outreach-engagements";
import {
  computeHeatmap,
  computeMultiOpens,
  enrichMultiOpens,
} from "@/lib/analytics-derivations";

// Returns heatmap + multi-open card data for the given date range.
// Kept isolated from /api/salesforce/stats so the two can run in parallel
// client-side and so one integration failing doesn't break the other.
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
    const [sends, events] = await Promise.all([
      fetchSendEvents(start, end),
      fetchOpenAndReplyEvents(start, end),
    ]);

    const heatmap = computeHeatmap(sends, events);
    const multiRaw = computeMultiOpens(events);

    // Only resolve prospect details for the top 20 multi-openers to limit API churn.
    const top = multiRaw.slice(0, 20);
    const prospectInfo = await fetchProspectsByIds(top.map((m) => m.prospectId));
    const multiOpens = enrichMultiOpens(top, prospectInfo);

    return NextResponse.json({
      heatmap,
      multiOpens,
      totals: {
        sends: sends.length,
        events: events.length,
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
