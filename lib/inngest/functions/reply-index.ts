import { inngest } from "@/lib/inngest/client";
import { indexSentReplies } from "@/lib/reply-search";

/**
 * Reply search index (lib/reply-search.ts): nightly, the last two weeks of
 * Sent Items; on request (first setup, "Index now"), up to a year. Read only.
 * One run at a time; capped per run and per day inside indexSentReplies.
 */
export const replyIndexJob = inngest.createFunction(
  {
    id: "inbox-reply-index",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=America/Toronto 40 2 * * *" }, { event: "inbox/reply-index" }],
  },
  async ({ event, step }) => {
    const asked = Number((event?.data as { sinceDays?: number } | undefined)?.sinceDays);
    const sinceDays = Number.isFinite(asked) && asked > 0 ? Math.min(365, Math.round(asked)) : 14;
    return step.run("index-sent-replies", () => indexSentReplies(sinceDays));
  },
);
