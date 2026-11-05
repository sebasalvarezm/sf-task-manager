import { inngest } from "@/lib/inngest/client";
import { runScheduled } from "@/lib/scheduled-actions";

/**
 * Records "Submit Monday" RCEs in Salesforce at 7am Montreal. It runs every
 * morning, not only Mondays, so an entry missed on its Monday (paused, an
 * outage) is picked up the next day instead of being forgotten. On a day
 * with nothing due it does nothing.
 */
export const scheduledActionsJob = inngest.createFunction(
  { id: "open-tasks-scheduled-actions", retries: 1, concurrency: { limit: 1 }, triggers: [{ cron: "TZ=America/Toronto 0 7 * * *" }] },
  async ({ step }) => {
    // Up to 5 rounds of RUN_CAP entries, each its own step so one slow round
    // never runs into the time limit. Stops as soon as a round finds nothing.
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      const s = await step.run(`record-due-${i}`, () => runScheduled({ respectPause: true }));
      rounds.push(s);
      if (s.paused || s.recorded + s.skipped + s.failed === 0) break;
    }
    return rounds;
  },
);
