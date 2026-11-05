import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  cancelScheduled,
  getScheduledSettings,
  listScheduled,
  runScheduled,
  saveScheduledSettings,
  scheduleActions,
  type QueuedAction,
} from "@/lib/scheduled-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Open Tasks "Submit Monday".
 * GET: the schedule and the pause switch.
 * POST { action: "schedule", actions } saves future-week RCEs for their Monday.
 * POST { action: "cancel", ids } takes entries off. { action: "run_now", ids } records them now.
 * POST { action: "settings", paused } pauses or resumes the 7am run.
 */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [items, settings] = await Promise.all([listScheduled(), getScheduledSettings()]);
  return NextResponse.json({ items, settings });
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; actions?: QueuedAction[]; ids?: string[]; paused?: boolean };
  try {
    if (body.action === "schedule") {
      if (!Array.isArray(body.actions) || body.actions.length === 0) return NextResponse.json({ error: "Nothing to schedule" }, { status: 400 });
      const result = await scheduleActions(body.actions.slice(0, 500));
      return NextResponse.json({ ...result, items: await listScheduled() });
    }
    if (body.action === "cancel") {
      const result = await cancelScheduled(Array.isArray(body.ids) ? body.ids : []);
      return NextResponse.json({ ...result, items: await listScheduled() });
    }
    if (body.action === "run_now") {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (ids.length === 0) return NextResponse.json({ error: "Nothing selected" }, { status: 400 });
      const summary = await runScheduled({ ids });
      return NextResponse.json({ summary, items: await listScheduled() });
    }
    if (body.action === "settings") {
      return NextResponse.json({ settings: await saveScheduledSettings(body.paused === true) });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong";
    if (message === "NOT_CONNECTED") return NextResponse.json({ error: "Salesforce isn't connected." }, { status: 409 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
