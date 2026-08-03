import { inngest } from "@/lib/inngest/client";
import { markRunning, markSucceeded, markFailed, updateProgress } from "@/lib/jobs";
import {
  runOneCallLog,
  type CallLogEntry,
  type CallLogResult,
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
      const results: CallLogResult[] = [];
      const total = input.entries.length;
      for (let i = 0; i < total; i++) {
        // One memoized step per call makes retries safe: completed calls are not
        // re-created if a later entry fails or the function resumes.
        const result = await step.run(`log-call-${i}`, () => runOneCallLog(input.entries[i]));
        results.push(result);
        await step.run(`progress-${i}`, () => updateProgress(jobId, {
          step: `${i + 1} of ${total} logged`,
          pct: total ? Math.round(((i + 1) / total) * 100) : 100,
        }));
      }
      const result = {
        results,
        successCount: results.filter((r) => r.success).length,
        failCount: results.filter((r) => !r.success).length,
      };
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
