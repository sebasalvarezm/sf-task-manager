import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  findRecentSourcingByUrl,
  normalizeSourcingUrl,
} from "@/lib/jobs";

export const dynamic = "force-dynamic";

// Pre-flight cache lookup before the Sourcing page kicks off a fresh job.
// Returns { found: false } or { found: true, jobId, ageDays }.
export async function POST(req: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const normalized = normalizeSourcingUrl(body.url);
  if (!normalized) {
    return NextResponse.json({ found: false });
  }

  try {
    const job = await findRecentSourcingByUrl(normalized, 90);
    if (!job) {
      return NextResponse.json({ found: false });
    }
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    return NextResponse.json({ found: true, jobId: job.id, ageDays });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
