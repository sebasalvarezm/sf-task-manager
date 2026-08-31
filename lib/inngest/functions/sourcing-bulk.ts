import { inngest } from "@/lib/inngest/client";
import {
  markRunning,
  markSucceeded,
  markFailed,
  updateProgress,
  findRecentSourcingByUrl,
  normalizeSourcingUrl,
  recordResolvedUrls,
} from "@/lib/jobs";
import {
  runFullSourcing,
  runFastSourcingClassification,
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

      // Store the resolved URLs on the job so a later cache lookup can match a
      // company in this batch by reading `input` alone, instead of pulling
      // every batch's full payload to compare one URL.
      await step.run("record-resolved-urls", () =>
        recordResolvedUrls(
          jobId,
          items.map((i) => i.url).filter((u): u is string => !!u),
        ),
      );

      const total = items.length;
      const quickMatches: Array<SourcingResult["portfolioMatch"] | null> =
        Array.from({ length: total }, () => null);

      // Classify every company first so Weekly Outreach shows Industry and
      // Subgroup/Sequence quickly, before the slower Wayback, hook, address,
      // restaurant, and email work begins. Cached runs reuse their prior match;
      // new runs use the exact same classifier as full sourcing.
      const classificationConcurrency = 3;
      for (let start = 0; start < items.length; start += classificationConcurrency) {
        const chunk = items.slice(start, start + classificationConcurrency);
        const matches = await Promise.all(
          chunk.map(async (item, offset) => {
            const i = start + offset;
            if (!item.url || item.error) return null;
            return step.run(`classify-${i}`, async () => {
              try {
                const cached = await findRecentSourcingByUrl(
                  normalizeSourcingUrl(item.url!),
                  90,
                );
                const cachedResult = cached?.result
                  ? (cached.result as unknown as SourcingResult)
                  : null;
                const match =
                  cachedResult?.portfolioMatch ??
                  (await runFastSourcingClassification(item.url!));

                const weeklyId = input.weeklyOutreachIds?.[i];
                if (weeklyId && match.matched) {
                  const classification: Record<string, string> = {};
                  if (match.mainGroup) classification.industry = match.mainGroup;
                  if (match.group) classification.group_name = match.group;
                  if (Object.keys(classification).length > 0) {
                    await getSupabaseAdmin()
                      .from("weekly_outreach")
                      .update(classification)
                      .eq("id", weeklyId);
                  }
                }
                return match;
              } catch {
                // Classification is an acceleration only. If it fails, the
                // full run below retries the normal path and retains today's
                // quality/fallback behavior.
                return null;
              }
            });
          }),
        );
        matches.forEach((match, offset) => {
          quickMatches[start + offset] = match;
        });
        const classified = Math.min(start + chunk.length, total);
        await step.run(`classification-progress-${classified}`, () =>
          updateProgress(jobId, {
            step: `Classified ${classified} of ${total}; deep research next`,
            pct: total > 0 ? Math.round((classified / total) * 20) : 20,
          }),
        );
      }

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
              try {
                // requireArchive: re-run companies whose archive history was
                // lost to an Archive.org outage rather than reusing the gap.
                const cached = await findRecentSourcingByUrl(
                  normalizeSourcingUrl(url),
                  90,
                  undefined,
                  true,
                );
                if (cached?.result) {
                  return {
                    cached: true,
                    result: cached.result as unknown as SourcingResult,
                    error: null,
                  };
                }
                const result = await runFullSourcing({
                  url,
                  portfolioMatchOverride: quickMatches[i] ?? undefined,
                });
                const trimmed: SourcingResult = {
                  ...result,
                  currentText:
                    typeof result.currentText === "string"
                      ? result.currentText.slice(0, 500)
                      : "",
                };
                return { cached: false, result: trimmed, error: null };
              } catch (sourceError) {
                return {
                  cached: false,
                  result: null,
                  error:
                    sourceError instanceof Error
                      ? sourceError.message
                      : "This company could not be sourced",
                };
              }
            });
            if (outcome.error || !outcome.result) {
              return {
                ...item,
                cached: false,
                result: null,
                error: outcome.error ?? "This company could not be sourced",
              };
            }
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
          if (!item.result || item.error) {
            await supabase
              .from("weekly_outreach")
              .update({
                status: "needs_context",
                context_summary: item.error ?? "This company could not be sourced",
              })
              .eq("id", input.weeklyOutreachIds[i]);
            continue;
          }
          const packaged = item.result.prepackagedEmail;
          const draft = packaged && !packaged.skipped
            ? [packaged.subject, packaged.body].filter(Boolean).join("\n\n")
            : null;
          const classification = item.result.portfolioMatch.matched
            ? {
                ...(item.result.portfolioMatch.mainGroup
                  ? { industry: item.result.portfolioMatch.mainGroup }
                  : {}),
                ...(item.result.portfolioMatch.group
                  ? { group_name: item.result.portfolioMatch.group }
                  : {}),
              }
            : {};
          await supabase
            .from("weekly_outreach")
            .update({
              ...classification,
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
      if (Array.isArray(input.weeklyOutreachIds) && input.weeklyOutreachIds.length > 0) {
        await step.run("release-weekly-outreach-after-failure", async () => {
          await getSupabaseAdmin()
            .from("weekly_outreach")
            .update({
              status: "needs_context",
              sourcing_job_id: null,
              context_summary: `Batch stopped: ${msg}`,
            })
            .in("id", input.weeklyOutreachIds!);
        });
      }
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
