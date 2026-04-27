import { inngest } from "@/lib/inngest/client";
import {
  markRunning,
  markSucceeded,
  markFailed,
  updateProgress,
} from "@/lib/jobs";
import { runTripSearch } from "@/lib/jobs/trip-search-runner";

export const tripSearchJob = inngest.createFunction(
  {
    id: "trip-search-job",
    retries: 1,
    triggers: [{ event: "job/trip_search" }],
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as {
      jobId: string;
      input: { location: string; radiusMiles?: number };
    };

    await step.run("mark-running", () => markRunning(jobId));
    await step.run("progress-start", () =>
      updateProgress(jobId, { step: "geocoding + searching", pct: 10 }),
    );

    try {
      const result = await step.run("run-trip-search", () =>
        runTripSearch(input),
      );
      await step.run("mark-succeeded", () =>
        markSucceeded(jobId, result as unknown as Record<string, unknown>),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
