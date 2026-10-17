import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getCandidateSettings, saveCandidateSettings } from "@/lib/outreach-candidates";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ settings: await getCandidateSettings() });
}

/** PUT { ...settings } validates and stores the pool filters and the rule thresholds. */
export async function PUT(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    return NextResponse.json({ settings: await saveCandidateSettings(body) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save settings" }, { status: 500 });
  }
}
