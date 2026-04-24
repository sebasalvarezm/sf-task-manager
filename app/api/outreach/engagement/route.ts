import { NextResponse, NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  fetchMailingsWithEngagement,
  fetchProspectsByIds,
  fetchCdmMailboxIds,
} from "@/lib/outreach-engagements";
import {
  computeHeatmap,
  computeMultiOpens,
  enrichMultiOpens,
} from "@/lib/analytics-derivations";
import { CDM_OWNER_NAMES } from "@/lib/salesforce-stats";

// Returns heatmap + multi-open card data for the given date range.
// Only counts mailings sent from the CDM team's Outreach mailboxes.
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
    // First resolve CDM team's mailbox IDs (one /mailboxes call with
    // include=user). Then fetch mailings and filter to just those mailboxes.
    const cdm = await fetchCdmMailboxIds(CDM_OWNER_NAMES);

    const {
      mailings,
      rawCount,
      stateBreakdown,
      withDeliveredAt,
      withProspectId,
      countFilteredByMailbox,
      earliestCreatedAt,
      latestCreatedAt,
      countInRange,
      countBeforeRange,
      countAfterRange,
      sampleDates,
      sampleRelationshipKeys,
    } = await fetchMailingsWithEngagement(start, end, cdm.mailboxIds);

    const heatmap = computeHeatmap(mailings);
    const multiRaw = computeMultiOpens(mailings);

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
      cdm: {
        matchedOwners: cdm.matched,
        unmatchedOwners: cdm.unmatched,
        mailboxCount: cdm.mailboxIds.size,
      },
      debug: {
        rawCount,
        withDeliveredAt,
        withProspectId,
        countFilteredByMailbox,
        stateBreakdown,
        earliestCreatedAt,
        latestCreatedAt,
        countInRange,
        countBeforeRange,
        countAfterRange,
        sampleDates,
        sampleRelationshipKeys,
        requestedRange: { start, end },
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
