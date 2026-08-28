import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getJob, markSucceeded, normalizeSourcingUrl } from "@/lib/jobs";
import {
  rerunHookResearch,
  type SourcingResult,
} from "@/lib/jobs/sourcing-runner";

export const dynamic = "force-dynamic";
// The research ladder makes up to two search calls plus one page read.
export const maxDuration = 300;

/**
 * Re-research the email hook for one already-sourced company, using public
 * sources rather than the Wayback Machine.
 *
 * Runs inline rather than as a background job: it is a handful of seconds, and
 * the user is waiting on the result in front of them.
 *
 * Body: { jobId, url? }. `url` is only needed for a bulk job, where one row
 * holds many companies and we have to know which one to patch.
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
    const job = await getJob(body.jobId);
    if (!job || !job.result) {
      return NextResponse.json(
        { error: "That sourcing run could not be found." },
        { status: 404 },
      );
    }

    const stored = job.result as Record<string, unknown>;
    const wantedUrl = body.url ? normalizeSourcingUrl(body.url) : "";

    // A single run stores one company at the top level; a bulk run stores many
    // under `items`. Locate the right one either way.
    const items = Array.isArray(stored.items)
      ? (stored.items as Array<Record<string, unknown>>)
      : null;

    let target: SourcingResult | null = null;
    let itemIndex = -1;

    if (items) {
      itemIndex = items.findIndex((item) => {
        const itemUrl = typeof item.url === "string" ? item.url : "";
        return (
          !!item.result &&
          (!wantedUrl || normalizeSourcingUrl(itemUrl) === wantedUrl)
        );
      });
      if (itemIndex >= 0) {
        target = items[itemIndex].result as SourcingResult;
      }
    } else if (typeof stored.url === "string") {
      target = stored as unknown as SourcingResult;
    }

    if (!target) {
      return NextResponse.json(
        { error: "Could not find that company in the sourcing run." },
        { status: 404 },
      );
    }

    const patch = await rerunHookResearch(target);
    const updated: SourcingResult = {
      ...target,
      ...patch,
      // Keep the original run's log and append this pass, so the trail of what
      // produced the current hook stays readable.
      logs: [
        ...(target.logs ?? []),
        "--- Hook re-researched from public sources ---",
        ...patch.logs,
      ],
    };

    if (items && itemIndex >= 0) {
      items[itemIndex] = { ...items[itemIndex], result: updated };
      await markSucceeded(job.id, { ...stored, items });
    } else {
      await markSucceeded(job.id, updated as unknown as Record<string, unknown>);
    }

    return NextResponse.json({
      emailHook: updated.emailHook,
      hookAnchor: updated.hookAnchor ?? null,
      hookSource: updated.hookSource ?? null,
      hookSearchCount: updated.hookSearchCount ?? 0,
      prepackagedEmail: updated.prepackagedEmail ?? null,
      logs: patch.logs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
