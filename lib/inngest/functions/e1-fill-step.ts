import { inngest } from "@/lib/inngest/client";
import { fillStepMailing, findStepMailing, getSend, getSendSettings, updateSend } from "@/lib/e1-sends";

/**
 * Automatic E1 (settings.fillStep): the prospect is already in the sequence.
 * Wait until Outreach opens step 1 (inside the sequence's schedule hours it is
 * immediate; outside, the state waits "pending" until the schedule opens),
 * then write the reviewed email into step 1's own mailing and schedule it.
 * Waits up to about four days, which covers a weekend.
 */
const WAITS = ["30s", "1m", "2m", "5m", "10m", "20m", "30m", "1h", "1h", "2h", "2h", "4h", "4h", "4h", "6h", "6h", "6h", "6h", "6h", "6h", "6h", "6h", "6h", "6h"];

export const e1FillStepJob = inngest.createFunction(
  {
    id: "e1-fill-step",
    retries: 2,
    triggers: [{ event: "e1/fill-step" }],
    onFailure: async ({ event, error }) => {
      const data = (event.data as { event?: { data?: { id?: string } } }).event?.data;
      if (data?.id) await updateSend(data.id, { status: "failed", status_reason: `Automatic send stopped: ${error.message}` }).catch(() => null);
    },
  },
  async ({ event, step }) => {
    const { id, stateId, sendAt } = event.data as { id: string; stateId: string; sendAt: string };
    for (let i = 0; i <= WAITS.length; i++) {
      const found = await step.run(`find-${i}`, async () => {
        const row = await getSend(id);
        if (!row || row.status !== "scheduling") return { stop: true as const };
        const m = await findStepMailing(stateId);
        return m ? { stop: false as const, mailingId: m.mailingId } : null;
      });
      if (found?.stop) return { id, stopped: "row no longer waiting" };
      if (found && !found.stop) {
        const row = await step.run("fill", async () => {
          const settings = await getSendSettings();
          return (await fillStepMailing(id, found.mailingId, new Date(sendAt), settings)).status;
        });
        return { id, status: row };
      }
      if (i < WAITS.length) await step.sleep(`wait-${i}`, WAITS[i]);
    }
    await step.run("give-up", () => updateSend(id, { status: "failed", status_reason: "Outreach never opened step 1 for this prospect (four days). Check the sequence is active and the prospect is in it." }));
    return { id, status: "failed" };
  },
);
