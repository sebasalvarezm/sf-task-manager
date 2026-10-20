import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createJob, markFailed } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";
import { getSupabaseAdmin } from "@/lib/supabase";
import { countUnscreenedEligible, countLinkedInBackfill, countScreenedToday } from "@/lib/outreach-screen";
import { getCandidateSettings } from "@/lib/outreach-candidates";

export const dynamic = "force-dynamic";

/** GET: how many eligible accounts still need the software check, and whether a check is running. */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [pending, running, today, settings] = await Promise.all([countUnscreenedEligible(), runningJob(), countScreenedToday(), getCandidateSettings()]);
    return NextResponse.json({ pending, job: running, checkedToday: today, dailyCap: settings.maxChecksPerDay });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
  }
}

/** POST { limit? } starts a prescreen job unless one is already running. */
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: number };
    const existing = await runningJob();
    if (existing) return NextResponse.json({ jobId: existing.id, status: existing.status, duplicate: true });
    const [pending, linkedin, today, settings] = await Promise.all([countUnscreenedEligible(), countLinkedInBackfill(), countScreenedToday(), getCandidateSettings()]);
    if (pending === 0 && linkedin === 0) return NextResponse.json({ jobId: null, status: "nothing_to_do", pending: 0 });
    // The daily cap is the real guardrail: each check costs a model call and a
    // web search, and a page bug once chained through the whole backlog in an
    // afternoon. Whatever the page asks for, no more than this many rows a day.
    const room = Math.max(0, settings.maxChecksPerDay - today);
    if (pending > 0 && room === 0) {
      return NextResponse.json({ jobId: null, status: "daily_cap", pending, checkedToday: today, dailyCap: settings.maxChecksPerDay });
    }
    const limit = Math.min(200, room || 200, Math.max(1, Number(body.limit) || 60));
    const label = pending > 0 ? `Outreach check: ${Math.min(limit, pending)} accounts` : `Outreach: finding ${Math.min(60, linkedin)} LinkedIn pages`;
    const job = await createJob({ kind: "outreach_screen", input: { limit }, label, resultRoute: "/outreach" });
    try {
      await inngest.send({ id: job.id, name: "job/outreach_screen", data: { jobId: job.id, input: job.input } });
    } catch (sendErr) {
      await markFailed(job.id, "Could not start the background check. Try again.").catch(() => {});
      throw sendErr;
    }
    return NextResponse.json({ jobId: job.id, status: job.status, pending });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    if (/job_kind|invalid input value for enum/.test(message)) {
      return NextResponse.json({ error: "The outreach_screen job kind is missing. Run supabase/2026-10-outreach-candidates.sql in the Supabase SQL editor once." }, { status: 500 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function runningJob(): Promise<{ id: string; status: string; progress: unknown } | null> {
  const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data } = await getSupabaseAdmin()
    .from("jobs")
    .select("id, status, progress")
    .eq("kind", "outreach_screen")
    .in("status", ["queued", "running"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data?.[0] as { id: string; status: string; progress: unknown } | undefined) ?? null;
}
