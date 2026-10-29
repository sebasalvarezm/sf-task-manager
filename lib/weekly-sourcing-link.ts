import { createJob, findRecentSourcingByUrl, markFailed, normalizeSourcingUrl } from "./jobs";
import { inngest } from "./inngest/client";
import { getSupabaseAdmin } from "./supabase";
import type { WeeklyOutreachItem } from "./weekly-outreach";

/**
 * An E1 added to Weekly Outreach for a company Seb already ran through
 * Sourcing (in the last 90 days) is linked to that research straight away:
 * a one-batch run for the new rows, which reuses the stored result instead of
 * researching again, writes the draft and hands it to the send queue. Before
 * this, the row sat there waiting for "Prepare E1 sourcing batch" (Connixt,
 * Oct 2026). Rows with no earlier run are left alone; the button still covers them.
 *
 * Returns the rows that were linked, with their new status, so the page shows
 * them as researching at once. Never throws: adding the row already worked.
 */
export async function reuseRecentSourcing(items: WeeklyOutreachItem[]): Promise<WeeklyOutreachItem[]> {
  try {
    const candidates = items.filter((i) => i.outreach_type === "E1" && i.website && !i.draft && !i.sourcing_job_id && i.status !== "sent");
    if (candidates.length === 0) return [];
    const matched: WeeklyOutreachItem[] = [];
    for (const item of candidates) {
      const url = normalizeSourcingUrl(item.website!);
      if (!url) continue;
      const hit = await findRecentSourcingByUrl(url, 90, undefined, true).catch(() => null);
      if (hit) matched.push(item);
    }
    if (matched.length === 0) return [];
    const job = await createJob({
      kind: "sourcing_bulk",
      input: { entries: matched.map((i) => i.website!), weeklyOutreachIds: matched.map((i) => i.id) },
      label: `Weekly Outreach: ${matched.length} E1${matched.length === 1 ? "" : "s"} from earlier Sourcing`,
    });
    await getSupabaseAdmin().from("jobs").update({ result_route: `/sourcing?jobId=${job.id}` }).eq("id", job.id);
    const { error } = await getSupabaseAdmin()
      .from("weekly_outreach")
      .update({ status: "researching", sourcing_job_id: job.id })
      .in("id", matched.map((i) => i.id));
    if (error) {
      await markFailed(job.id, "Could not mark the Weekly Outreach rows.").catch(() => undefined);
      return [];
    }
    try {
      await inngest.send({ id: job.id, name: "job/sourcing_bulk", data: { jobId: job.id, input: job.input } });
    } catch {
      await markFailed(job.id, "Could not start the background job.").catch(() => undefined);
      await getSupabaseAdmin().from("weekly_outreach").update({ status: "queued", sourcing_job_id: null }).in("id", matched.map((i) => i.id));
      return [];
    }
    return matched.map((i) => ({ ...i, status: "researching", sourcing_job_id: job.id }));
  } catch {
    return [];
  }
}
