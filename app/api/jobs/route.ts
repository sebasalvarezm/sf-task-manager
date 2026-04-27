import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { listJobs, summarize } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const jobs = await listJobs(undefined, 20);
    const { inProgressCount, unreadCount } = summarize(jobs);
    return NextResponse.json({ jobs, inProgressCount, unreadCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
