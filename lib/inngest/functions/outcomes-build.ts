import { inngest } from "@/lib/inngest/client";
import { markJobFailedFromInngest } from "@/lib/inngest/on-failure";
import { markRunning, markSucceeded, markFailed, updateProgress } from "@/lib/jobs";
import { syncMailings, buildSends, buildAndSaveReport, LOOKBACK_MONTHS } from "@/lib/outcomes";

/**
 * Outcomes build. Three stages, each its own step so a retry resumes where it
 * stopped: (1) walk Outreach mailings newest first into the cache, ten pages
 * per step, until the lookback is covered; (2) rebuild outreach_sends from
 * Salesforce plus the cache; (3) compute the report and save it.
 */
export const outcomesBuildJob = inngest.createFunction(
  {
    id: "outcomes-build-job",
    retries: 1,
    triggers: [{ event: "job/outcomes_build" }],
    onFailure: (failure) => markJobFailedFromInngest(failure),
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as { jobId: string; input: { skipMailings?: boolean } };
    const since = new Date(Date.now() - (LOOKBACK_MONTHS + 1) * 30 * 86_400_000).toISOString();

    await step.run("mark-running", () => markRunning(jobId));
    try {
      let mailings = 0;
      if (!input.skipMailings) {
        let cursor: string | null = null;
        for (let i = 0; i < 120; i++) {
          const result: { next: string | null; written: number } = await step.run(`mailings-${i}`, () => syncMailings(cursor, since, 10));
          mailings += result.written;
          cursor = result.next;
          await step.run(`mailings-progress-${i}`, () => updateProgress(jobId, { step: `Reading Outreach: ${mailings} mailings`, pct: Math.min(60, 5 + i) }));
          if (!cursor) break;
        }
      }
      await step.run("progress-sends", () => updateProgress(jobId, { step: "Matching Salesforce sends to replies and calls", pct: 70 }));
      const built = await step.run("build-sends", () => buildSends());
      await step.run("progress-report", () => updateProgress(jobId, { step: "Working out what predicts a reply", pct: 90 }));
      const report = await step.run("build-report", async () => {
        const r = await buildAndSaveReport();
        return { sends: r.sends, replies: r.replies, calls: r.calls, auc: r.model.auc };
      });
      await step.run("mark-succeeded", () => markSucceeded(jobId, { mailings, ...built, auc: report.auc }));
      return { ok: true, jobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
