import { NextResponse } from "next/server";
import { getRole } from "@/lib/auth";
import { INTERN_JOB_KINDS } from "@/lib/roles";
import { createJob, type JobKind } from "@/lib/jobs";
import { inngest } from "@/lib/inngest/client";

const VALID_KINDS: ReadonlySet<JobKind> = new Set([
  "sourcing",
  "sourcing_bulk",
  "prep",
  "task_bulk",
  "trip_geocode",
  "trip_search",
  "calls_log",
  "accounts_enrich",
]);

/** JSON with object keys sorted, so a stored jsonb value (Postgres reorders
 * keys) compares equal to the same value sent from the browser. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function POST(req: Request) {
  const role = await getRole();
  if (role === null) {
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

  // Middleware has to allow /api/jobs for the Sourcing tool, but this endpoint
  // can launch any tool's job — so restrict interns to Sourcing kinds here.
  if (role === "intern" && !INTERN_JOB_KINDS.includes(body.kind)) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  try {
    // Double-click / double-submit guard: if the same job (same kind, same
    // input) is already queued or running from the last 10 minutes, hand back
    // that job instead of starting a second copy.
    const { getSupabaseAdmin } = await import("@/lib/supabase");
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: inFlight } = await getSupabaseAdmin()
      .from("jobs")
      .select("id, status, input")
      .eq("kind", body.kind)
      .in("status", ["queued", "running"])
      .gte("created_at", since)
      .limit(20);
    const sameInput = stableJson(body.input);
    const duplicate = (inFlight ?? []).find(
      (j) => stableJson(j.input) === sameInput,
    );
    if (duplicate) {
      return NextResponse.json({ jobId: duplicate.id, status: duplicate.status, duplicate: true });
    }

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
      await getSupabaseAdmin()
        .from("jobs")
        .update({ result_route: finalRoute })
        .eq("id", job.id);
    }

    try {
      await inngest.send({
        // Event id = job id, so Inngest itself ignores a repeated send.
        id: job.id,
        name: `job/${job.kind}`,
        data: { jobId: job.id, input: job.input },
      });
    } catch (sendErr) {
      // Don't leave a row stuck at "queued" when the job never started.
      const { markFailed } = await import("@/lib/jobs");
      await markFailed(job.id, "Could not start the background job. Try again.").catch(() => {});
      throw sendErr;
    }

    return NextResponse.json({ jobId: job.id, status: job.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
