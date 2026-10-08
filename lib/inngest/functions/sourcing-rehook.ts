import { inngest } from "@/lib/inngest/client";
import { markJobFailedFromInngest } from "@/lib/inngest/on-failure";
import {
  getJob,
  markRunning,
  markSucceeded,
  markFailed,
  normalizeSourcingUrl,
  updateProgress,
} from "@/lib/jobs";
import { rerunHookResearch, type SourcingResult } from "@/lib/jobs/sourcing-runner";

/**
 * "Deep research this hook" for one already-sourced company. It used to run
 * inside the web request and was cut off by the platform's request limit
 * before it could answer (the page saw an empty reply). As a background job it
 * can take the minutes it needs; the page polls the job like any other.
 *
 * input: { sourcingJobId, url? }  (url picks the company inside a bulk run)
 * result: { changed, emailHook, hookAnchor, hookSource, hookSearchCount, prepackagedEmail, logs }
 */
export const sourcingRehookJob = inngest.createFunction(
  {
    id: "sourcing-rehook-job",
    retries: 0,
    triggers: [{ event: "job/sourcing_rehook" }],
    onFailure: (failure) => markJobFailedFromInngest(failure),
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as {
      jobId: string;
      input: { sourcingJobId: string; url?: string };
    };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      const outcome = await step.run("research", async () => {
        await updateProgress(jobId, { step: "Researching public sources for a verifiable hook", pct: 10 }).catch(() => {});
        const job = await getJob(input.sourcingJobId);
        if (!job || !job.result) throw new Error("That sourcing run could not be found.");

        const stored = job.result as Record<string, unknown>;
        const wantedUrl = input.url ? normalizeSourcingUrl(input.url) : "";
        const items = Array.isArray(stored.items) ? (stored.items as Array<Record<string, unknown>>) : null;

        let target: SourcingResult | null = null;
        let itemIndex = -1;
        if (items) {
          itemIndex = items.findIndex((item) => {
            const itemUrl = typeof item.url === "string" ? item.url : "";
            return !!item.result && (!wantedUrl || normalizeSourcingUrl(itemUrl) === wantedUrl);
          });
          if (itemIndex >= 0) target = items[itemIndex].result as SourcingResult;
        } else if (typeof stored.url === "string") {
          target = stored as unknown as SourcingResult;
        }
        if (!target) throw new Error("Could not find that company in the sourcing run.");

        const patch = await rerunHookResearch(target);
        const updated: SourcingResult = {
          ...target,
          ...patch,
          logs: [...(target.logs ?? []), "--- Hook re-researched from public sources ---", ...patch.logs],
        };

        // Write the new hook back onto the original sourcing run so the page
        // shows it on reload and bulk rows pick it up.
        if (items && itemIndex >= 0) {
          items[itemIndex] = { ...items[itemIndex], result: updated };
          await markSucceeded(job.id, { ...stored, items }, false);
        } else {
          await markSucceeded(job.id, updated as unknown as Record<string, unknown>, false);
        }

        return {
          changed: patch.emailHook !== undefined,
          emailHook: updated.emailHook ?? null,
          hookAnchor: updated.hookAnchor ?? null,
          hookSource: updated.hookSource ?? null,
          hookSearchCount: updated.hookSearchCount ?? 0,
          prepackagedEmail: updated.prepackagedEmail ?? null,
          logs: patch.logs,
        };
      });

      await step.run("mark-succeeded", () => markSucceeded(jobId, outcome as unknown as Record<string, unknown>));
      return { ok: true, jobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
