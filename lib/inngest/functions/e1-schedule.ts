import { inngest } from "@/lib/inngest/client";
import { markJobFailedFromInngest } from "@/lib/inngest/on-failure";
import { markRunning, markSucceeded, markFailed, updateProgress } from "@/lib/jobs";
import { createMailingForSend, enrolSend, getSend, getSendSettings, listSends, planSlotsFor, updateSend } from "@/lib/e1-sends";
import { outreachRequest } from "@/lib/outreach";

/**
 * Send queue, step two: for every approved row, put the prospect in the
 * sequence, wait for Outreach to create the manual step's task, create the
 * mailing on it with the reviewed text and the planned send time, and (unless
 * dry run) mark it scheduled. Each row is independent: one failure never stops
 * the others, and a failure is written on the row with its reason.
 */
const TASK_WAITS = ["20s", "40s", "1m", "2m", "5m", "10m", "20m", "30m", "60m", "60m"];

export const e1ScheduleJob = inngest.createFunction(
  {
    id: "e1-schedule-job",
    retries: 1,
    triggers: [{ event: "job/e1_schedule" }],
    onFailure: (failure) => markJobFailedFromInngest(failure),
  },
  async ({ event, step }) => {
    const { jobId, input } = event.data as { jobId: string; input: { ids: string[] } };
    await step.run("mark-running", () => markRunning(jobId));
    try {
      const settings = await step.run("settings", () => getSendSettings());
      // Slots for the whole batch at once, so the morning/evening split and spacing hold across rows.
      const slots = await step.run("plan-slots", async () => {
        const all = await listSends();
        const approved = all.filter((s) => input.ids.includes(s.id) && s.status === "approved");
        const plan = planSlotsFor(approved);
        return Object.fromEntries(Array.from(plan.entries()).map(([id, at]) => [id, at.toISOString()]));
      });
      let done = 0;
      const counts = { scheduled: 0, dryRun: 0, failed: 0, skipped: 0 };
      for (const id of input.ids) {
        const sendAt = slots[id];
        if (!sendAt) {
          counts.skipped++;
          continue;
        }
        const enrol = await step.run(`enrol-${id}`, async () => {
          try {
            const r = await enrolSend(id);
            if ("blocked" in r) {
              await updateSend(id, { status: "failed", status_reason: r.blocked });
              return null;
            }
            return r;
          } catch (err) {
            await updateSend(id, { status: "failed", status_reason: err instanceof Error ? err.message : "Could not enrol in Outreach." });
            return null;
          }
        });
        if (!enrol) {
          counts.failed++;
          continue;
        }
        const outcome = await step.run(`mailing-${id}`, async () => {
          try {
            const row = await createMailingForSend(id, { prospectId: enrol.prospectId, mailboxId: enrol.mailboxId }, new Date(sendAt), settings);
            return row.status;
          } catch (err) {
            await outreachRequest(`/sequenceStates/${enrol.stateId}`, { method: "DELETE" }).catch(() => null);
            await updateSend(id, { status: "failed", status_reason: err instanceof Error ? err.message : "Could not create the mailing." });
            return "failed";
          }
        });
        if (outcome === "scheduled") counts.scheduled++;
        else if (outcome === "dry_run") counts.dryRun++;
        else counts.failed++;
        done++;
        await step.run(`progress-${id}`, () => updateProgress(jobId, { step: `Scheduled ${done} of ${input.ids.length}`, pct: Math.round((done / input.ids.length) * 100) }));
      }
      await step.run("mark-succeeded", () => markSucceeded(jobId, counts));
      return { ok: true, jobId, ...counts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      await step.run("mark-failed", () => markFailed(jobId, msg));
      // Rows still "scheduling" after a crash go back to approved so they can be retried.
      await step.run("release", async () => {
        for (const id of input.ids) {
          const s = await getSend(id).catch(() => null);
          if (s?.status === "scheduling") await updateSend(id, { status: "approved", status_reason: `Scheduling stopped: ${msg}` });
        }
      });
      throw err;
    }
  },
);
