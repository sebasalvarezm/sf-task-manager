import { NextResponse, NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getValidCredentials } from "@/lib/token-manager";
import {
  fetchTaskCountsForRange,
  fetchTaskCountsByBucket,
  fetchOpportunitiesByStage,
  fetchOpenBROByOriginator,
  fetchF2FThisYear,
  fetchStuckOpportunities,
  CDM_OWNER_NAMES,
  TaskCountRow,
} from "@/lib/salesforce-stats";
import { Bucket } from "@/lib/date-ranges";
import { computeConversion } from "@/lib/analytics-derivations";

// Returns all stats for the selected range:
// { kpis, byPerson, byBucket, byStage, byOriginator }
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const bucketsParam = url.searchParams.get("buckets");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Missing start or end query parameter" },
      { status: 400 }
    );
  }

  let buckets: Bucket[] = [];
  if (bucketsParam) {
    try {
      buckets = JSON.parse(bucketsParam);
    } catch {
      return NextResponse.json(
        { error: "Invalid buckets parameter" },
        { status: 400 }
      );
    }
  }

  try {
    const credentials = await getValidCredentials();
    if (!credentials) {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }

    const [taskRows, bucketRows, stageRows, originatorRows, f2fYtd, stuckOpps] =
      await Promise.all([
        fetchTaskCountsForRange(credentials, start, end),
        fetchTaskCountsByBucket(credentials, buckets),
        fetchOpportunitiesByStage(credentials),
        fetchOpenBROByOriginator(credentials),
        fetchF2FThisYear(credentials),
        fetchStuckOpportunities(credentials),
      ]);

    const kpis = computeKpis(taskRows);
    const byPerson = computeByPerson(taskRows, originatorRows);

    const totalOpenBRO = originatorRows.reduce((sum, r) => sum + r.total, 0);

    // E1+RCE1 → completed calls (C1 + RCC) conversion (team + per person)
    const teamCompletedCalls = kpis.c1 + kpis.rcc;
    const teamConversion = computeConversion(kpis.totalOutreach, teamCompletedCalls);
    const conversionByPerson = byPerson.map((p) => ({
      owner: p.owner,
      ...computeConversion(p.outreach, p.c1 + p.rcc),
    }));

    return NextResponse.json({
      kpis: {
        totalOutreach: kpis.totalOutreach,
        e1: kpis.e1,
        rce1: kpis.rce1,
        de1: kpis.de1,
        totalCalls: kpis.c1 + kpis.rcc,
        c1: kpis.c1,
        rcc: kpis.rcc,
        totalF2F: kpis.f2f,
        totalOpenBRO,
        f2fThisYear: f2fYtd,
      },
      conversion: {
        team: teamConversion,
        byPerson: conversionByPerson,
      },
      byPerson,
      byBucket: bucketRows,
      byStage: stageRows,
      byOriginator: originatorRows,
      stuckOpps,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (message === "NOT_CONNECTED") {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }

    console.error("stats route error:", message);
    return NextResponse.json(
      { error: `Salesforce error: ${message}` },
      { status: 500 }
    );
  }
}

function computeKpis(rows: TaskCountRow[]) {
  let e1 = 0, rce1 = 0, de1 = 0, c1 = 0, rcc = 0, f2f = 0;
  for (const r of rows) {
    if (r.type === "E1") e1 += r.count;
    else if (r.type === "RCE1") rce1 += r.count;
    else if (r.type === "D-E1") de1 += r.count;
    else if (r.type === "C1") c1 += r.count;
    else if (r.type === "RCC") rcc += r.count;
    else if (r.type === "F2F") f2f += r.count;
  }
  return { e1, rce1, de1, c1, rcc, f2f, totalOutreach: e1 + rce1 + de1 };
}

type PersonBreakdown = {
  owner: string;
  e1: number;
  rce1: number;
  de1: number;
  outreach: number;
  c1: number;
  rcc: number;
  f2f: number;
  openBRO: number;
};

function computeByPerson(
  taskRows: TaskCountRow[],
  originatorRows: { owner: string; total: number }[]
): PersonBreakdown[] {
  const byOwner = new Map<string, PersonBreakdown>();
  for (const name of CDM_OWNER_NAMES) {
    byOwner.set(name, {
      owner: name,
      e1: 0,
      rce1: 0,
      de1: 0,
      outreach: 0,
      c1: 0,
      rcc: 0,
      f2f: 0,
      openBRO: 0,
    });
  }

  for (const r of taskRows) {
    const p = byOwner.get(r.owner);
    if (!p) continue;
    if (r.type === "E1") p.e1 += r.count;
    else if (r.type === "RCE1") p.rce1 += r.count;
    else if (r.type === "D-E1") p.de1 += r.count;
    else if (r.type === "C1") p.c1 += r.count;
    else if (r.type === "RCC") p.rcc += r.count;
    else if (r.type === "F2F") p.f2f += r.count;
  }

  for (const p of byOwner.values()) {
    p.outreach = p.e1 + p.rce1 + p.de1;
  }

  for (const r of originatorRows) {
    const p = byOwner.get(r.owner);
    if (p) p.openBRO = r.total;
  }

  return Array.from(byOwner.values());
}
