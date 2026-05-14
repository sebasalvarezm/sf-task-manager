import { NextResponse, NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getValidCredentials } from "@/lib/token-manager";
import {
  fetchDrillAccountsForTasks,
  fetchDrillOppsByOriginator,
  fetchDrillOppsByStage,
  type DrillAccountRow,
  type TrackedSubjectType,
} from "@/lib/salesforce-stats";

export const dynamic = "force-dynamic";

type Dimension =
  | "outreach_by_person"   // E1 + RCE1 + D-E1 by owner
  | "e1_by_person"          // just E1 by owner
  | "rce1_by_person"        // just RCE1 by owner
  | "de1_by_person"         // just D-E1 (divestment E1s) by owner
  | "calls_by_person"       // C1 / RCC / F2F by owner (filter via callType)
  | "conversion_by_person"  // accounts who got C1+RCC from this owner
  | "bro_by_originator"     // open BROs by owner
  | "bro_by_stage";         // open BROs in a given stage

const VALID: Dimension[] = [
  "outreach_by_person",
  "e1_by_person",
  "rce1_by_person",
  "de1_by_person",
  "calls_by_person",
  "conversion_by_person",
  "bro_by_originator",
  "bro_by_stage",
];

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dimension = url.searchParams.get("dimension") as Dimension | null;
  const owner = url.searchParams.get("owner") ?? "";
  const stage = url.searchParams.get("stage") ?? "";
  const callType = url.searchParams.get("callType") ?? "";
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";

  if (!dimension || !VALID.includes(dimension)) {
    return NextResponse.json(
      { error: `Unknown dimension: ${dimension}` },
      { status: 400 },
    );
  }

  try {
    const credentials = await getValidCredentials();
    if (!credentials) {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }

    let rows: DrillAccountRow[] = [];

    switch (dimension) {
      case "outreach_by_person": {
        if (!owner || !start || !end) {
          return NextResponse.json(
            { error: "owner, start, end required" },
            { status: 400 },
          );
        }
        rows = await fetchDrillAccountsForTasks(credentials, {
          types: ["E1", "RCE1", "D-E1"],
          ownerName: owner,
          rangeStart: start,
          rangeEnd: end,
        });
        break;
      }
      case "e1_by_person": {
        if (!owner || !start || !end) {
          return NextResponse.json(
            { error: "owner, start, end required" },
            { status: 400 },
          );
        }
        rows = await fetchDrillAccountsForTasks(credentials, {
          types: ["E1"],
          ownerName: owner,
          rangeStart: start,
          rangeEnd: end,
        });
        break;
      }
      case "rce1_by_person": {
        if (!owner || !start || !end) {
          return NextResponse.json(
            { error: "owner, start, end required" },
            { status: 400 },
          );
        }
        rows = await fetchDrillAccountsForTasks(credentials, {
          types: ["RCE1"],
          ownerName: owner,
          rangeStart: start,
          rangeEnd: end,
        });
        break;
      }
      case "de1_by_person": {
        if (!owner || !start || !end) {
          return NextResponse.json(
            { error: "owner, start, end required" },
            { status: 400 },
          );
        }
        rows = await fetchDrillAccountsForTasks(credentials, {
          types: ["D-E1"],
          ownerName: owner,
          rangeStart: start,
          rangeEnd: end,
        });
        break;
      }
      case "calls_by_person": {
        if (!owner || !start || !end) {
          return NextResponse.json(
            { error: "owner, start, end required" },
            { status: 400 },
          );
        }
        // callType: "c1" | "rcc" | "f2f" | "" (any of the three)
        const types = (() => {
          const ct = callType.toLowerCase();
          if (ct === "c1") return ["C1"] as TrackedSubjectType[];
          if (ct === "rcc") return ["RCC"] as TrackedSubjectType[];
          if (ct === "f2f") return ["F2F"] as TrackedSubjectType[];
          return ["C1", "RCC", "F2F"] as TrackedSubjectType[];
        })();
        rows = await fetchDrillAccountsForTasks(credentials, {
          types,
          ownerName: owner,
          rangeStart: start,
          rangeEnd: end,
        });
        break;
      }
      case "conversion_by_person": {
        if (!owner || !start || !end) {
          return NextResponse.json(
            { error: "owner, start, end required" },
            { status: 400 },
          );
        }
        // Show the converted accounts (C1 + RCC by this person in window).
        rows = await fetchDrillAccountsForTasks(credentials, {
          types: ["C1", "RCC"],
          ownerName: owner,
          rangeStart: start,
          rangeEnd: end,
        });
        break;
      }
      case "bro_by_originator": {
        if (!owner) {
          return NextResponse.json({ error: "owner required" }, { status: 400 });
        }
        rows = await fetchDrillOppsByOriginator(credentials, owner);
        break;
      }
      case "bro_by_stage": {
        if (!stage) {
          return NextResponse.json({ error: "stage required" }, { status: 400 });
        }
        rows = await fetchDrillOppsByStage(credentials, stage);
        break;
      }
    }

    return NextResponse.json({ rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === "NOT_CONNECTED") {
      return NextResponse.json({ error: "NOT_CONNECTED" }, { status: 403 });
    }
    console.error("stats drill error:", message);
    return NextResponse.json(
      { error: `Salesforce error: ${message}` },
      { status: 500 },
    );
  }
}
