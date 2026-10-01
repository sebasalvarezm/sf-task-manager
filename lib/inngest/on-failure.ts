import { markFailed } from "@/lib/jobs";

// Shared `onFailure` handler for every background job.
//
// Each job already marks itself failed in its own try/catch, but that never
// runs when Vercel kills the request (300-second limit) or Inngest gives up
// after its retries. Inngest calls onFailure in those cases too, so the job
// row is marked failed instead of showing "running" forever.
export async function markJobFailedFromInngest(failure: {
  event: unknown;
  error: unknown;
}): Promise<string | null> {
  const jobId = (failure.event as { data?: { event?: { data?: { jobId?: unknown } } } })
    ?.data?.event?.data?.jobId;
  if (typeof jobId !== "string") return null;
  const message =
    failure.error instanceof Error && failure.error.message
      ? failure.error.message
      : "The background job stopped unexpectedly.";
  await markFailed(jobId, message);
  return jobId;
}
