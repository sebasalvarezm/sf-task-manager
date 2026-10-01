import { NextResponse } from "next/server";
import { getRole } from "@/lib/auth";
import { INTERN_JOB_KINDS } from "@/lib/roles";
import { getJob, cancelJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const role = await getRole();
  if (role === null) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const job = await getJob(id);
    // Interns may only open Sourcing jobs.
    if (!job || (role === "intern" && !INTERN_JOB_KINDS.includes(job.kind))) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Cancel an in-flight job (only affects queued/running rows). The Inngest
// function may still complete on the server but the UI immediately unblocks.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const role = await getRole();
  if (role === null) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const { id } = await params;
  try {
    if (role === "intern") {
      const job = await getJob(id);
      if (!job || !INTERN_JOB_KINDS.includes(job.kind)) {
        return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
      }
    }
    const cancelled = await cancelJob(id);
    return NextResponse.json({ cancelled });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
