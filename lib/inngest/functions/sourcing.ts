import { inngest } from "@/lib/inngest/client";
import {
  markRunning,
  markSucceeded,
  markFailed,
  updateProgress,
} from "@/lib/jobs";
import { runFullSourcing } from "@/lib/jobs/sourcing-runner";

export const sourcingJob = inngest.createFunction(
  {
    id: "sourcing-job",
    retries: 1,
    triggers: [{ event: "job/sourcing" }],
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as {
      jobId: string;
      input: { url: string };
    };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      const result = await step.run("run-sourcing", async () => {
        return await runFullSourcing({
          url: input.url,
          onProgress: async (stepName, pct) => {
            // Best-effort progress write — don't fail the job on progress hiccups
            try {
              await updateProgress(jobId, { step: stepName, pct });
            } catch {
              /* ignore */
            }
          },
        });
      });

      // Trim huge fields before persisting (currentText can be ~10KB)
      const persisted = {
        ...result,
        currentText:
          typeof result.currentText === "string"
            ? result.currentText.slice(0, 500)
            : null,
      };

      await step.run("mark-succeeded", () =>
        markSucceeded(jobId, persisted as unknown as Record<string, unknown>),
      );
      return { ok: true, jobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
