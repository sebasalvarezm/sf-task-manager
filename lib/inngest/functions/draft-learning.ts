import { inngest } from "@/lib/inngest/client";
import { runDraftLearning } from "@/lib/draft-learning";

/**
 * Learning from Seb's edits (lib/draft-learning.ts): Sunday 5pm Montreal,
 * before the 7pm weekly check, the week's edited emails are compared and
 * repeated changes become proposals on the Weekly check page. One model
 * call. Proposals change nothing until Seb accepts them.
 */
export const draftLearningJob = inngest.createFunction(
  {
    id: "draft-learning-weekly",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=America/Toronto 0 17 * * 0" }, { event: "draft-learning/run" }],
  },
  async ({ step }) => step.run("review-edits", () => runDraftLearning(7)),
);
