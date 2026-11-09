import { inngest } from "@/lib/inngest/client";
import { runContactNotes } from "@/lib/contact-notes";

/**
 * "Will contact this week" lines in Salesforce account descriptions
 * (lib/contact-notes.ts). Every 15 minutes on weekdays, 7am to 8pm Montreal,
 * and right after Weekly Outreach rows are added or removed. One run at a
 * time; the run is idempotent, so extra requests do nothing new.
 */
export const contactNotesJob = inngest.createFunction(
  {
    id: "weekly-outreach-contact-notes",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=America/Toronto */15 7-20 * * 1-5" }, { event: "weekly-outreach/contact-notes" }],
  },
  async ({ step }) => step.run("update-descriptions", () => runContactNotes()),
);
