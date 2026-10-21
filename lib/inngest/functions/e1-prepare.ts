import { inngest } from "@/lib/inngest/client";
import { markJobFailedFromInngest } from "@/lib/inngest/on-failure";
import { markRunning, markSucceeded, markFailed, updateProgress } from "@/lib/jobs";
import { createSendsForWeek, getSendSettings, prepareSend } from "@/lib/e1-sends";
import { listSequences, type OutreachSequence } from "@/lib/outreach";

/**
 * Send queue, step one: turn this week's draft-ready E1s into send rows and
 * run every check on each (contact, verification, sequence, draft review).
 * One step per row so a retry picks up where it stopped.
 */
export const e1PrepareJob = inngest.createFunction(
  {
    id: "e1-prepare-job",
    retries: 1,
    triggers: [{ event: "job/e1_prepare" }],
    onFailure: (failure) => markJobFailedFromInngest(failure),
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as { jobId: string; input: { weekStart?: string; ids?: string[] } };
    await step.run("mark-running", () => markRunning(jobId));
    try {
      const ids: string[] = input.ids?.length
        ? input.ids
        : await step.run("create-rows", () => createSendsForWeek(input.weekStart));
      const settings = await step.run("settings", () => getSendSettings());
      const sequences = (await step.run("sequences", () => listSequences().catch(() => [] as OutreachSequence[]))) as OutreachSequence[];
      let done = 0;
      const counts = { ready: 0, review: 0, other: 0 };
      for (const id of ids) {
        const status = await step.run(`prepare-${id}`, async () => (await prepareSend(id, { sequences, settings })).status);
        if (status === "ready") counts.ready++;
        else if (status === "review") counts.review++;
        else counts.other++;
        done++;
        await step.run(`progress-${done}`, () => updateProgress(jobId, { step: `Checked ${done} of ${ids.length}`, pct: Math.round((done / ids.length) * 100) }));
      }
      await step.run("mark-succeeded", () => markSucceeded(jobId, { total: ids.length, ...counts }));
      return { ok: true, jobId, ...counts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
