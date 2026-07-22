import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { searchSourcingRuns } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// Search past succeeded sourcing runs by URL or Salesforce account name.
// GET /api/sourcing/search?q=<query> -> { matches, truncated }.
export async function GET(req: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (!q.trim()) {
    return NextResponse.json({ matches: [], truncated: false });
  }

  try {
    const { matches, truncated } = await searchSourcingRuns(q);
    return NextResponse.json({ matches, truncated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
