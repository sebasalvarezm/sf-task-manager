import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { listJobs, summarize, type JobListItem } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/**
 * Fingerprint of the current job list, used as an ETag.
 *
 * This endpoint is polled every 3-60 seconds from every open tab, and between
 * most polls nothing has changed. With an ETag the browser sends
 * `If-None-Match` and we answer 304 with no body, so an unchanged poll costs a
 * few hundred bytes of headers instead of a full payload.
 *
 * Built from the newest `updated_at` plus the counts, which together change on
 * any status change, any new job, and any read/unread change.
 */
function fingerprint(
  jobs: JobListItem[],
  inProgressCount: number,
  unreadCount: number,
): string {
  let newest = "";
  for (const j of jobs) {
    const stamp = j.updated_at ?? j.created_at;
    if (stamp > newest) newest = stamp;
  }
  return `W/"${jobs.length}-${inProgressCount}-${unreadCount}-${newest}"`;
}

export async function GET(req: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const jobs = await listJobs(undefined, 20);
    const { inProgressCount, unreadCount } = summarize(jobs);
    const etag = fingerprint(jobs, inProgressCount, unreadCount);

    if (req.headers.get("if-none-match") === etag) {
      // Nothing changed — send no body at all.
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, no-cache" },
      });
    }

    return NextResponse.json(
      { jobs, inProgressCount, unreadCount },
      { headers: { ETag: etag, "Cache-Control": "private, no-cache" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
