import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createJob, markFailed } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";
import { getSupabaseAdmin } from "@/lib/supabase";
import { countUnscreenedEligible, countLinkedInBackfill, countScreenedToday } from "@/lib/outreach-screen";
import { getCandidateSettings } from "@/lib/outreach-candidates";
import { spentTodayUsd } from "@/lib/model-cost";

export const dynamic = "force-dynamic";

/** GET: how many eligible accounts still need the software check, and whether a check is running. */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [pending, running, today, settings, spent] = await Promise.all([countUnscreenedEligible(), runningJob(), countScreenedToday(), getCandidateSettings(), spentTodayUsd(["outreach_screen", "outreach_linkedin"]).catch(() => 0)]);
    return NextResponse.json({ pending, job: running, checkedToday: today, dailyCap: settings.maxChecksPerDay, spentToday: spent, spendCap: settings.maxCheckSpendPerDay, paused: settings.paused });
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
    const [pending, linkedin, today, settings, spent] = await Promise.all([countUnscreenedEligible(), countLinkedInBackfill(), countScreenedToday(), getCandidateSettings(), spentTodayUsd(["outreach_screen", "outreach_linkedin"]).catch(() => 0)]);
    if (settings.paused) return NextResponse.json({ jobId: null, status: "paused", pending });
    if (pending === 0 && linkedin === 0) return NextResponse.json({ jobId: null, status: "nothing_to_do", pending: 0 });
    // Two hard caps, both server side, both covering the LinkedIn lookups as
    // well as the screens: rows per day and dollars per day. A page bug once
    // chained through the whole backlog in an afternoon; the lookups then
    // slipped past the row cap. Nothing starts past either line.
    const room = Math.max(0, settings.maxChecksPerDay - today);
    if (room === 0) {
      return NextResponse.json({ jobId: null, status: "daily_cap", pending, checkedToday: today, dailyCap: settings.maxChecksPerDay });
    }
    if (spent >= settings.maxCheckSpendPerDay) {
      return NextResponse.json({ jobId: null, status: "spend_cap", pending, spentToday: spent, spendCap: settings.maxCheckSpendPerDay });
    }
    // Third, independent line: jobs per day, counted in the jobs table. Holds
    // even if the spend log or the screened_at stamps were somehow not written.
    const jobsToday = await countJobsToday();
    if (jobsToday >= MAX_JOBS_PER_DAY) {
      return NextResponse.json({ jobId: null, status: "daily_cap", pending, checkedToday: today, dailyCap: settings.maxChecksPerDay, jobsToday });
    }
    const limit = Math.min(200, room, Math.max(1, Number(body.limit) || 60));
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

const MAX_JOBS_PER_DAY = 10;

async function countJobsToday(): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await getSupabaseAdmin()
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("kind", "outreach_screen")
    .gte("created_at", start.toISOString());
  return count ?? 0;
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
