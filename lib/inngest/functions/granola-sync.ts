import { inngest } from "@/lib/inngest/client";
import { currentAndPreviousWeek, runGranolaSync } from "@/lib/granola-sync";
import { isGranolaConfigured } from "@/lib/granola";
import { findAccountsByDomains } from "@/lib/salesforce-calls";
import { suggestForRow } from "@/lib/call-suggest-run";

/**
 * Every 30 minutes: pull this week's and last week's Granola notes into the
 * Call Logger, then write suggestions for any new or changed notes so they're
 * ready when you open it. Reads only: nothing is written to Granola, Outlook
 * or Salesforce. Skips quietly until GRANOLA_API_KEY is set.
 */
export const granolaSyncJob = inngest.createFunction(
  {
    id: "granola-sync",
    retries: 1,
    // Never two syncs at once (schedule overlapping a slow run).
    concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=America/Toronto */30 * * * *" }],
  },
  async ({ step }) => {
    if (!isGranolaConfigured()) return { skipped: "GRANOLA_API_KEY not set" };

    const stored = await step.run("sync-notes", async () => {
      // Errors are recorded for the Call Logger to show, then rethrown.
      const { results } = await runGranolaSync(currentAndPreviousWeek(), "schedule");
      return results.flatMap((r) => r.stored);
    });

    // Suggestions are a bonus: one failing never fails the sync.
    for (let i = 0; i < stored.length; i++) {
      const row = stored[i];
      await step.run(`suggest-${row.noteId}`, async () => {
        try {
          const accounts = await findAccountsByDomains(row.domains);
          const account = row.domains.map((d) => accounts.get(d)).find(Boolean) ?? null;
          if (!account) return { skipped: "no Salesforce account" };
          await suggestForRow({
            eventId: row.eventId,
            meetingTitle: row.subject,
            meetingDate: row.meetingDate,
            accountId: account.accountId,
            accountName: account.accountName,
          });
          return { ok: true };
        } catch (err) {
          return { skipped: err instanceof Error ? err.message : "failed" };
        }
      });
    }
    return { stored: stored.length };
  },
);
