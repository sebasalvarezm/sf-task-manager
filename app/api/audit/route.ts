import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getAuditSettings, getLastReport, runAudit, saveAuditSettings } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET: last report and settings. POST { action: "run" } runs the check now; { action: "settings", paused }. Admin only. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [report, settings] = await Promise.all([getLastReport(), getAuditSettings()]);
  return NextResponse.json({ report, settings });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; paused?: boolean };
  try {
    if (body.action === "run") return NextResponse.json({ report: await runAudit() });
    if (body.action === "settings") return NextResponse.json({ settings: await saveAuditSettings({ paused: body.paused === true }) });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "The check failed" }, { status: 500 });
  }
}
