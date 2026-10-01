import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { readSyncState, runGranolaSync, type GranolaSyncState } from "@/lib/granola-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Last sync time and error, for the Call Logger. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ state: await readSyncState().catch(() => null) });
}

/** "Sync from Granola": sync the selected week now. */
export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { start?: string; end?: string };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!body.start || !body.end || !iso.test(body.start) || !iso.test(body.end)) {
    return NextResponse.json({ error: "Pick a week first" }, { status: 400 });
  }
  try {
    const { results, state } = await runGranolaSync([{ start: body.start, end: body.end }], "button");
    const r = results[0];
    return NextResponse.json({
      state,
      result: { meetings: r.meetings, matched: r.matched, unchanged: r.unchanged, unmatched: r.unmatched, skippedInternal: r.skippedInternal },
    });
  } catch (err) {
    const state = (err as { state?: GranolaSyncState }).state ?? null;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Granola sync failed.", state },
      { status: 502 },
    );
  }
}
