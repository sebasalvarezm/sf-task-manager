import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createJob, getJob } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";

export const dynamic = "force-dynamic";

/**
 * Start "Deep research this hook" as a background job and return its id.
 * The research itself runs in lib/inngest/functions/sourcing-rehook.ts; the
 * page polls /api/jobs/<id> for the result. (Running it inline hit the
 * platform's request limit and the page received an empty reply.)
 *
 * Body: { jobId, url? }. `url` picks the company inside a bulk run.
 */
export async function POST(req: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: { jobId?: string; url?: string };
  try {
    body = (await req.json()) as { jobId?: string; url?: string };
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (!body.jobId || typeof body.jobId !== "string") {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  try {
    const sourcingJob = await getJob(body.jobId);
    if (!sourcingJob || !sourcingJob.result) {
      return NextResponse.json({ error: "That sourcing run could not be found." }, { status: 404 });
    }
    const label = body.url ? `Hook research: ${body.url}` : `Hook research: ${sourcingJob.label ?? body.jobId}`;
    const job = await createJob({
      kind: "sourcing_rehook",
      input: { sourcingJobId: body.jobId, url: body.url ?? null },
      label,
      resultRoute: `/sourcing?jobId=${encodeURIComponent(body.jobId)}`,
    });
    await inngest.send({ name: "job/sourcing_rehook", data: { jobId: job.id, input: { sourcingJobId: body.jobId, url: body.url } } });
    return NextResponse.json({ jobId: job.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
