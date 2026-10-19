import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createJob, markFailed } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";
import { getSupabaseAdmin } from "@/lib/supabase";
import { loadReport } from "@/lib/outcomes";
import { sfQuery } from "@/lib/sf-query";

export const dynamic = "force-dynamic";

/** GET: the saved report (or null) and whether a build is running. ?diag=1 adds table counts for troubleshooting. */
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [report, job] = await Promise.all([loadReport(), runningJob()]);
    const sender = new URL(request.url).searchParams.get("sender");
    if (sender) return NextResponse.json({ sender, rows: await senderRows(sender) });
    if (new URL(request.url).searchParams.get("diag")) {
      return NextResponse.json({ report: report ? { sends: report.sends, matchedToOutreach: report.matchedToOutreach, replies: report.replies } : null, job, diag: await diagnostics() });
    }
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

/** One sender's tracked sends with the account's website, for a by-hand look at list quality. */
async function senderRows(sender: string) {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("outreach_sends")
    .select("account_id, account_name, sent_on, subject_type, industry, country, employees, founded, quality, sequence_name, replied_at, call_on")
    .eq("sender", sender)
    .not("mailing_id", "is", null)
    .order("sent_on", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown> & { account_id: string }>;
  const ids = Array.from(new Set(rows.map((r) => r.account_id)));
  const websites = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 300) {
    const recs = await sfQuery<{ Id: string; Website: string | null }>(`SELECT Id, Website FROM Account WHERE Id IN (${ids.slice(i, i + 300).map((x) => `'${x}'`).join(",")})`);
    for (const r of recs) websites.set(r.Id, r.Website ?? null);
  }
  return rows.map((r) => ({ ...r, website: websites.get(r.account_id) ?? null, replied: !!r.replied_at, called: !!r.call_on }));
}

async function diagnostics() {
  const db = getSupabaseAdmin();
  const n = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count, error } = await q;
    return error ? `error: ${error.message}` : count ?? 0;
  };
  const head = { count: "exact" as const, head: true };
  const { data: sampleMailings } = await db.from("outreach_mailings").select("mailing_id, email, state, delivered_at, replied_at, sequence_name, mailing_type").order("created_at", { ascending: false }).limit(3);
  const { data: sampleSends } = await db.from("outreach_sends").select("sf_task_id, contact_email, sent_on, sender").order("sent_on", { ascending: false }).limit(3);
  const { data: lastJob } = await db.from("jobs").select("status, result, error, progress, created_at").eq("kind", "outcomes_build").order("created_at", { ascending: false }).limit(1);
  return {
    mailings_total: await n(db.from("outreach_mailings").select("*", head)),
    mailings_with_email: await n(db.from("outreach_mailings").select("*", head).not("email", "is", null)),
    mailings_replied: await n(db.from("outreach_mailings").select("*", head).not("replied_at", "is", null)),
    sends_total: await n(db.from("outreach_sends").select("*", head)),
    sends_with_email: await n(db.from("outreach_sends").select("*", head).not("contact_email", "is", null)),
    sample_mailings: sampleMailings ?? [],
    sample_sends: sampleSends ?? [],
    last_job: lastJob?.[0] ?? null,
  };
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
