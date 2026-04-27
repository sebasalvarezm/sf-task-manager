import { inngest } from "@/lib/inngest/client";
import { markRunning, markSucceeded, markFailed } from "@/lib/jobs";
import {
  runPrepGenerate,
  type PrepInput,
} from "@/lib/jobs/prep-runner";

export const prepJob = inngest.createFunction(
  {
    id: "prep-job",
    retries: 1,
    triggers: [{ event: "job/prep" }],
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as {
      jobId: string;
      input: PrepInput;
    };

    await step.run("mark-running", () => markRunning(jobId));

    try {
      const onePager = await step.run("generate-one-pager", () =>
        runPrepGenerate(input),
      );
      await step.run("mark-succeeded", () =>
        markSucceeded(
          jobId,
          { onePager } as unknown as Record<string, unknown>,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      throw err;
    }
  },
);
