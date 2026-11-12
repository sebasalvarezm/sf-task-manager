import { inngest } from "@/lib/inngest/client";
import { runContactNotes } from "@/lib/contact-notes";
import { claimWeeklyOutreachAccounts } from "@/lib/account-owner";

/**
 * Weekly Outreach upkeep in Salesforce, every 15 minutes on weekdays (7am to
 * 8pm Montreal) and right after rows are added or removed:
 *   1. "Will contact this week" lines in account descriptions (lib/contact-notes.ts)
 *   2. every Weekly Outreach account owned by Seb (lib/account-owner.ts)
 * One run at a time; both are idempotent, so extra requests do nothing new.
 * Each has its own pause switch on the Weekly check page.
 */
export const contactNotesJob = inngest.createFunction(
  {
    id: "weekly-outreach-contact-notes",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=America/Toronto */15 7-20 * * 1-5" }, { event: "weekly-outreach/contact-notes" }],
  },
  async ({ step }) => {
    const owners = await step.run("claim-owners", () => claimWeeklyOutreachAccounts());
    const notes = await step.run("update-descriptions", () => runContactNotes());
    return { owners, notes };
  },
);
