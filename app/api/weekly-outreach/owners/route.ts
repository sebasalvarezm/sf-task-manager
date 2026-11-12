import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { claimWeeklyOutreachAccounts, getOwnerSettings, saveOwnerSettings } from "@/lib/account-owner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Weekly Outreach accounts owned by Seb. GET: the switch. POST { action: "run" } or { action: "settings", paused }. Admin only. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ settings: await getOwnerSettings() });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; paused?: boolean };
  try {
    if (body.action === "run") return NextResponse.json({ run: await claimWeeklyOutreachAccounts() });
    if (body.action === "settings") return NextResponse.json({ settings: await saveOwnerSettings(body.paused === true) });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong";
    return NextResponse.json({ error: message === "NOT_CONNECTED" ? "Salesforce isn't connected." : message }, { status: message === "NOT_CONNECTED" ? 409 : 500 });
  }
}
