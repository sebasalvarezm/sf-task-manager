import { inngest } from "@/lib/inngest/client";
import { tidyStepTasks } from "@/lib/e1-sends";

/**
 * Hourly: tick off the step-1 "manual email" task for every email the queue
 * scheduled, once Outreach has created it, so the sequence carries on to the
 * follow-up steps without anyone touching Outreach.
 */
export const e1TaskTidy = inngest.createFunction(
  {
    id: "e1-task-tidy",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=America/Toronto 15 * * * *" }],
  },
  async ({ step }) => step.run("tidy", () => tidyStepTasks()),
);
