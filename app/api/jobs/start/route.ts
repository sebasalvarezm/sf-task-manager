import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { createJob, type JobKind } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";

const VALID_KINDS: ReadonlySet<JobKind> = new Set([
  "sourcing",
  "prep",
  "task_bulk",
  "trip_geocode",
]);

export async function POST(req: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: {
    kind?: string;
    input?: Record<string, unknown>;
    label?: string;
    resultRoute?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (!body.kind || !VALID_KINDS.has(body.kind as JobKind)) {
    return NextResponse.json(
      { error: `Unknown job kind: ${body.kind}` },
      { status: 400 },
    );
  }
  if (!body.input || typeof body.input !== "object") {
    return NextResponse.json({ error: "Missing input" }, { status: 400 });
  }

  try {
    // Pre-create with no resultRoute so we have an id; then update with the
    // template-substituted route. Lets callers use `{jobId}` placeholders.
    const job = await createJob({
      kind: body.kind as JobKind,
      input: body.input,
      label: body.label ?? null,
      resultRoute: body.resultRoute
        ? body.resultRoute.replace("{jobId}", "PLACEHOLDER")
        : null,
    });

    if (body.resultRoute && body.resultRoute.includes("{jobId}")) {
      const finalRoute = body.resultRoute.replace("{jobId}", job.id);
      const { getSupabaseAdmin } = await import("@/lib/supabase");
      await getSupabaseAdmin()
        .from("jobs")
        .update({ result_route: finalRoute })
        .eq("id", job.id);
    }

    await inngest.send({
      name: `job/${job.kind}`,
      data: { jobId: job.id, input: job.input },
    });

    return NextResponse.json({ jobId: job.id, status: job.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
