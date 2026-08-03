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
import { getSupabaseAdmin } from "@/lib/supabase";

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
      input: { entries: string[]; weeklyOutreachIds?: string[] };
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

      const concurrency = 3;
      for (let start = 0; start < items.length; start += concurrency) {
        const chunk = items.slice(start, start + concurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (item, offset): Promise<BulkSourcingItem> => {
            const i = start + offset;
            if (!item.url || item.error) return item;
            const url = item.url;
            const outcome = await step.run(`source-${i}`, async () => {
              const cached = await findRecentSourcingByUrl(normalizeSourcingUrl(url), 90);
              if (cached?.result) {
                return { cached: true, result: cached.result as unknown as SourcingResult };
              }
              const result = await runFullSourcing({ url });
              const trimmed: SourcingResult = {
                ...result,
                currentText: typeof result.currentText === "string" ? result.currentText.slice(0, 500) : "",
              };
              return { cached: false, result: trimmed };
            });
            return { ...item, cached: outcome.cached, result: outcome.result };
          }),
        );
        processed.push(...chunkResults);
        done += chunk.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        await step.run(`progress-${done}`, () =>
          updateProgress(jobId, {
            step: `Sourced ${done} of ${total}`,
            pct,
          }),
        );
      }

      if (Array.isArray(input.weeklyOutreachIds)) {
        const supabase = getSupabaseAdmin();
        for (let i = 0; i < Math.min(input.weeklyOutreachIds.length, processed.length); i++) {
          const item = processed[i];
          if (!item.result || item.error) continue;
          const packaged = item.result.prepackagedEmail;
          const draft = packaged && !packaged.skipped
            ? [packaged.subject, packaged.body].filter(Boolean).join("\n\n")
            : null;
          await supabase
            .from("weekly_outreach")
            .update({
              status: draft ? "draft_ready" : "needs_context",
              draft,
              context_summary: item.result.emailHook ?? null,
            })
            .eq("id", input.weeklyOutreachIds[i]);
        }
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
