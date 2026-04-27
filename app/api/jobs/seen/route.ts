import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { markAllSeen, markSeenByKinds, type JobKind } from "@/lib/jobs";

const VALID_KINDS: readonly JobKind[] = [
  "sourcing",
  "prep",
  "task_bulk",
  "trip_geocode",
  "trip_search",
  "calls_log",
];

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    let kinds: JobKind[] | null = null;
    try {
      const body = await req.json();
      if (body && Array.isArray(body.kinds)) {
        kinds = body.kinds.filter((k: unknown): k is JobKind =>
          typeof k === "string" && (VALID_KINDS as readonly string[]).includes(k),
        );
      }
    } catch {
      // No body or invalid JSON — treat as "mark all".
    }

    const updated =
      kinds && kinds.length > 0
        ? await markSeenByKinds(kinds)
        : await markAllSeen();
    return NextResponse.json({ updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
