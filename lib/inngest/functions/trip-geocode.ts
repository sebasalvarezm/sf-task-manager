import { inngest } from "@/lib/inngest/client";
import {
  markRunning,
  markSucceeded,
  markFailed,
  updateProgress,
} from "@/lib/jobs";
import { runTripGeocode } from "@/lib/jobs/trip-geocode-runner";

export const tripGeocodeJob = inngest.createFunction(
  {
    id: "trip-geocode-job",
    retries: 1,
    triggers: [{ event: "job/trip_geocode" }],
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      const result = await step.run("run-trip-geocode", () =>
        runTripGeocode(async (state) => {
          // Best-effort progress write between batches
          try {
            const pct =
              state.total > 0
                ? Math.round((state.cached / state.total) * 100)
                : 0;
            await updateProgress(jobId, {
              step: `${state.remaining} remaining`,
              pct,
            });
          } catch {
            /* ignore */
          }
        }),
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
