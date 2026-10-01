import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { listPrepLibrary } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// GET /api/prep/library
// Every Call Prep one-pager already generated, one per company, so /prep shows
// them on any device (not only the browser that generated them). /prep has
// called this since Aug 31, 2026, but the route file was never committed.
export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const entries = await listPrepLibrary();
    return NextResponse.json({ entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load past preps";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
