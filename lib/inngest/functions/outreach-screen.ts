import { inngest } from "@/lib/inngest/client";
import { markJobFailedFromInngest } from "@/lib/inngest/on-failure";
import { markRunning, markSucceeded, markFailed, updateProgress } from "@/lib/jobs";
import { runScreenBatch } from "@/lib/outreach-screen";

/**
 * Outreach prescreen. Screens the next N eligible, unchecked accounts (site
 * read plus one model call each) and writes the verdicts onto the candidate
 * rows. Runs in slices of 12 so each step stays well inside the step budget.
 */
export const outreachScreenJob = inngest.createFunction(
  {
    id: "outreach-screen-job",
    retries: 1,
    triggers: [{ event: "job/outreach_screen" }],
    onFailure: (failure) => markJobFailedFromInngest(failure),
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as { jobId: string; input: { limit?: number } };
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 60));
    const slice = 12;

    await step.run("mark-running", () => markRunning(jobId));
    try {
      const totals: Record<string, number> = {};
      let done = 0;
      for (let offset = 0; offset < limit; offset += slice) {
        const take = Math.min(slice, limit - offset);
        const counts = await step.run(`screen-${offset}`, () => runScreenBatch(take));
        for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + (v as number);
        done += counts.total;
        await step.run(`progress-${offset}`, () =>
          updateProgress(jobId, { step: `Checked ${done} of ${limit}`, pct: Math.round((done / limit) * 100) }),
        );
        if (counts.total < take) break; // queue drained
      }
      await step.run("mark-succeeded", () => markSucceeded(jobId, { ...totals, done }));
      return { ok: true, jobId, done };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
