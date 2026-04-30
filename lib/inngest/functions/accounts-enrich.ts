import { inngest } from "@/lib/inngest/client";
import {
  markRunning,
  markSucceeded,
  markFailed,
  updateProgress,
} from "@/lib/jobs";
import { runAccountsEnrichment } from "@/lib/jobs/accounts-runner";

export const accountsEnrichJob = inngest.createFunction(
  {
    id: "accounts-enrich-job",
    retries: 1,
    triggers: [{ event: "job/accounts_enrich" }],
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as {
      jobId: string;
      input: { urls: string[] };
    };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      const result = await step.run("run-enrichment", async () => {
        return await runAccountsEnrichment({
          urls: input.urls ?? [],
          onProgress: async ({ done, total }) => {
            try {
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              await updateProgress(jobId, {
                step: `Enriched ${done} of ${total}`,
                pct,
              });
            } catch {
              /* ignore */
            }
          },
        });
      });

      await step.run("mark-succeeded", () =>
        markSucceeded(jobId, result as unknown as Record<string, unknown>),
      );
      return { ok: true, jobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
