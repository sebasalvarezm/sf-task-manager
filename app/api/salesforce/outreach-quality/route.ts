import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getValidCredentials } from "@/lib/token-manager";
import {
  fetchOutreachQualityTasks,
  type StatsTeam,
} from "@/lib/salesforce-stats";
import { scoreAccountQuality } from "@/lib/outreach-quality";
import { getQualityThresholds } from "@/lib/outreach-quality-settings";

export const dynamic = "force-dynamic";

// Row-level detail behind the outreach quality ("BS") charts: every flagged
// email in the window, who sent it, and which signals fired. Optionally
// narrowed to one sender.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const owner = url.searchParams.get("owner");
  const team: StatsTeam =
    url.searchParams.get("team") === "cdm" ? "cdm" : "small_ma";

  if (!start || !end) {
    return NextResponse.json(
      { error: "Missing start or end query parameter" },
      { status: 400 }
    );
  }

  try {
    const credentials = await getValidCredentials();
    if (!credentials) {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }

    const [{ rows, foundedFieldAvailable }, thresholds] = await Promise.all([
      fetchOutreachQualityTasks(credentials, start, end, team),
      getQualityThresholds(),
    ]);

    const flagged = [];
    for (const row of rows) {
      if (owner && row.owner !== owner) continue;
      const verdict = scoreAccountQuality(row, thresholds, {
        foundedFieldAvailable,
      });
      if (!verdict.isBs) continue;
      flagged.push({ ...row, flags: verdict.flags, missing: verdict.missing });
    }

    return NextResponse.json({
      rows: flagged,
      thresholds,
      foundedFieldAvailable,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === "NOT_CONNECTED") {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }
    console.error("outreach-quality route error:", message);
    return NextResponse.json(
      { error: `Salesforce error: ${message}` },
      { status: 500 }
    );
  }
}
