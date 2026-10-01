import { inngest } from "@/lib/inngest/client";
import { markJobFailedFromInngest } from "@/lib/inngest/on-failure";
import {
  isJobCancelled,
  markRunning,
  markSucceeded,
  markFailed,
  updateProgress,
} from "@/lib/jobs";
import {
  GEOCODE_BATCH_SIZE,
  geocodeAccountBatch,
  listUncachedAccounts,
  summarise,
} from "@/lib/jobs/trip-geocode-runner";
import type { GeocodeFailure } from "@/lib/geocoding";

export const tripGeocodeJob = inngest.createFunction(
  {
    id: "trip-geocode-job",
    retries: 1,
    triggers: [{ event: "job/trip_geocode" }],
    onFailure: (failure) => markJobFailedFromInngest(failure),
  },
  async ({ event, step }) => {
    const { jobId } = event.data as { jobId: string };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      const { total, alreadyCached, uncached } = await step.run("list-accounts", () => listUncachedAccounts());

      // One step per batch: progress is saved between batches and no single
      // step gets near Vercel's 300-second limit.
      let geocoded = 0;
      const failed: GeocodeFailure[] = [];
      for (let i = 0, n = 0; i < uncached.length; i += GEOCODE_BATCH_SIZE, n++) {
        const cancelled = await step.run(`check-cancelled-${n}`, () => isJobCancelled(jobId));
        if (cancelled) return;
        const out = await step.run(`batch-${n}`, () =>
          geocodeAccountBatch(uncached.slice(i, i + GEOCODE_BATCH_SIZE)),
        );
        geocoded += out.geocoded;
        failed.push(...out.failed);
        const remaining = Math.max(0, uncached.length - (i + GEOCODE_BATCH_SIZE));
        await step.run(`progress-${n}`, () =>
          updateProgress(jobId, {
            step: `${remaining} remaining`,
            pct: total > 0 ? Math.round(((alreadyCached + (uncached.length - remaining)) / total) * 100) : 100,
          }).catch(() => {}),
        );
      }

      const result = summarise(total, alreadyCached, geocoded, failed);
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
