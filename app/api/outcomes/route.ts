import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createJob, markFailed } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";
import { getSupabaseAdmin } from "@/lib/supabase";
import { loadReport } from "@/lib/outcomes";

export const dynamic = "force-dynamic";

/** GET: the saved report (or null) and whether a build is running. */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [report, job] = await Promise.all([loadReport(), runningJob()]);
    return NextResponse.json({ report, job });
  } catch (err) {
    return NextResponse.json({ error: friendly(err) }, { status: 500 });
  }
}

/** POST { skipMailings? } starts a build unless one is already running. */
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { skipMailings?: boolean };
    const existing = await runningJob();
    if (existing) return NextResponse.json({ jobId: existing.id, status: existing.status, duplicate: true });
    const job = await createJob({ kind: "outcomes_build", input: { skipMailings: !!body.skipMailings }, label: "What gets replies: rebuild", resultRoute: "/replies" });
    try {
      await inngest.send({ id: job.id, name: "job/outcomes_build", data: { jobId: job.id, input: job.input } });
    } catch (sendErr) {
      await markFailed(job.id, "Could not start the build. Try again.").catch(() => {});
      throw sendErr;
    }
    return NextResponse.json({ jobId: job.id, status: job.status });
  } catch (err) {
    return NextResponse.json({ error: friendly(err) }, { status: 500 });
  }
}

function friendly(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (/job_kind|invalid input value for enum|outreach_sends|outreach_mailings/.test(message) && /enum|does not exist|relation|schema cache/.test(message)) {
    return "The outcomes tables are missing. Run supabase/2026-10-outcomes.sql in the Supabase SQL editor once.";
  }
  if (message === "OUTREACH_NOT_CONNECTED") return "Outreach isn't connected. Connect it from Stats first.";
  if (message === "NOT_CONNECTED") return "Salesforce isn't connected.";
  return message;
}

async function runningJob(): Promise<{ id: string; status: string; progress: unknown } | null> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await getSupabaseAdmin()
    .from("jobs")
    .select("id, status, progress")
    .eq("kind", "outcomes_build")
    .in("status", ["queued", "running"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data?.[0] as { id: string; status: string; progress: unknown } | undefined) ?? null;
}
