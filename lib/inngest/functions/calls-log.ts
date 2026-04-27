import { inngest } from "@/lib/inngest/client";
import { markRunning, markSucceeded, markFailed } from "@/lib/jobs";
import {
  runCallsLog,
  type CallLogEntry,
} from "@/lib/jobs/calls-log-runner";

export const callsLogJob = inngest.createFunction(
  {
    id: "calls-log-job",
    retries: 1,
    triggers: [{ event: "job/calls_log" }],
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as {
      jobId: string;
      input: { entries: CallLogEntry[] };
    };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      const result = await step.run("run-calls-log", () =>
        runCallsLog(input),
      );
      await step.run("mark-succeeded", () =>
        markSucceeded(jobId, result as unknown as Record<string, unknown>),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
