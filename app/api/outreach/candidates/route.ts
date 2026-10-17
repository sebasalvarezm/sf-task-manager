import { NextRequest, NextResponse } from "next/server";
import { friendlyConnectionError, isConnectionError } from "@/lib/connection-errors";
import { isAuthenticated } from "@/lib/auth";
import { listCandidates, pushCandidate, refreshCandidates, reopenCandidate, skipCandidate } from "@/lib/outreach-candidates";

export const dynamic = "force-dynamic";
// Refresh reads a year of E1s plus the task history of every account in the pool.
export const maxDuration = 120;

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (/outreach_candidates/.test(message) && /does not exist|relation|schema cache/.test(message)) {
    return NextResponse.json({ error: "The outreach_candidates table is missing. Run supabase/2026-10-outreach-candidates.sql in the Supabase SQL editor once." }, { status: 500 });
  }
  if (/weekly_outreach_source_check/.test(message)) {
    return NextResponse.json({ error: "Weekly Outreach does not accept the 'outreach' source yet. Run supabase/2026-10-outreach-candidates.sql in the Supabase SQL editor once." }, { status: 500 });
  }
  return NextResponse.json({ error: friendlyConnectionError(message) }, { status: isConnectionError(message) ? 409 : 500 });
}

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ items: await listCandidates() });
  } catch (err) {
    return fail(err);
  }
}

/** POST {} rebuilds the pool from Salesforce and re-runs the rule on every account. */
export async function POST() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // Summary only: the page reloads the list itself, which keeps this response tiny on mobile.
    return NextResponse.json({ summary: await refreshCandidates() });
  } catch (err) {
    return fail(err);
  }
}

/** PATCH { accountId, action: "push" | "skip" | "reopen", reason?, weekStart? } */
export async function PATCH(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as { accountId?: string; action?: string; reason?: string; weekStart?: string };
    if (!body.accountId) return NextResponse.json({ error: "Missing account" }, { status: 400 });
    if (body.action === "push") {
      const { row, item } = await pushCandidate(body.accountId, body.weekStart);
      return NextResponse.json({ item: row, weekly: item });
    }
    if (body.action === "skip") return NextResponse.json({ item: await skipCandidate(body.accountId, body.reason ?? null) });
    if (body.action === "reopen") return NextResponse.json({ item: await reopenCandidate(body.accountId) });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
