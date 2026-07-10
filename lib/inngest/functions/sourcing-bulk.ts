import { inngest } from "@/lib/inngest/client";
import {
  markRunning,
  markSucceeded,
  markFailed,
  updateProgress,
  findRecentSourcingByUrl,
  normalizeSourcingUrl,
} from "@/lib/jobs";
import {
  runFullSourcing,
  type SourcingResult,
} from "@/lib/jobs/sourcing-runner";
import {
  resolveEntries,
  type BulkSourcingItem,
} from "@/lib/jobs/sourcing-bulk-runner";

// Bulk sourcing. Each company is processed as its OWN `step.run`, so every
// Inngest invocation stays well under the platform's per-invocation limit
// (a single company is 30-90s; a batch of 10 wrapped in one step would risk
// ~15min and blow the 300s route maxDuration). Per-company steps also make the
// batch resumable — completed companies are memoized and skipped on retry.
export const sourcingBulkJob = inngest.createFunction(
  {
    id: "sourcing-bulk-job",
    retries: 1,
    triggers: [{ event: "job/sourcing_bulk" }],
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as {
      jobId: string;
      input: { entries: string[] };
    };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      // Resolve URLs / account names up front (cheap Salesforce lookups).
      const items = await step.run("resolve", () =>
        resolveEntries(input.entries ?? []),
      );

      const total = items.length;
      let done = 0;
      const processed: BulkSourcingItem[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Unresolvable entries (no URL / lookup error) pass straight through.
        if (!item.url || item.error) {
          processed.push(item);
        } else {
          const url = item.url;
          const outcome = await step.run(`source-${i}`, async () => {
            // Reuse a recent single-sourcing result if one exists (≤90 days).
            const cached = await findRecentSourcingByUrl(
              normalizeSourcingUrl(url),
              90,
            );
            if (cached && cached.result) {
              return {
                cached: true,
                result: cached.result as unknown as SourcingResult,
              };
            }
            // Otherwise run the full pipeline; trim the huge currentText field
            // before persisting (mirrors the single-sourcing Inngest fn).
            const result = await runFullSourcing({ url });
            const trimmed: SourcingResult = {
              ...result,
              currentText:
                typeof result.currentText === "string"
                  ? result.currentText.slice(0, 500)
                  : "",
            };
            return { cached: false, result: trimmed };
          });

          processed.push({
            ...item,
            cached: outcome.cached,
            result: outcome.result,
          });
        }

        done += 1;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        await step.run(`progress-${i}`, () =>
          updateProgress(jobId, {
            step: `Sourced ${done} of ${total}`,
            pct,
          }),
        );
      }

      await step.run("mark-succeeded", () =>
        markSucceeded(jobId, {
          items: processed,
        } as unknown as Record<string, unknown>),
      );
      return { ok: true, jobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
