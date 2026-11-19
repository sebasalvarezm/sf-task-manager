import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { changeHandled, loadHandled, type HandledStatus } from "@/lib/call-logger-handled";

/**
 * Call Logger memory: which meetings of a week were dismissed or logged.
 * GET ?week=YYYY-MM-DD · POST { eventIds, status, week } · DELETE { eventIds } (bring back).
 * App data only; nothing goes to Salesforce or Outlook.
 */
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 600).slice(0, 300) : []);

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const week = new URL(request.url).searchParams.get("week") ?? "";
  if (!WEEK.test(week)) return NextResponse.json({ error: "Missing week" }, { status: 400 });
  try {
    return NextResponse.json({ handled: await loadHandled(week) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not load" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { eventIds?: unknown; status?: string; week?: string };
  const eventIds = ids(body.eventIds);
  const status = body.status === "logged" ? "logged" : body.status === "dismissed" ? "dismissed" : null;
  if (!eventIds.length || !status || !WEEK.test(body.week ?? "")) return NextResponse.json({ error: "Missing meetings, status or week" }, { status: 400 });
  try {
    await changeHandled({ set: { ids: eventIds, status: status as HandledStatus, week: body.week! } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { eventIds?: unknown };
  const eventIds = ids(body.eventIds);
  if (!eventIds.length) return NextResponse.json({ error: "Missing meetings" }, { status: 400 });
  try {
    await changeHandled({ remove: eventIds });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save" }, { status: 500 });
  }
}
