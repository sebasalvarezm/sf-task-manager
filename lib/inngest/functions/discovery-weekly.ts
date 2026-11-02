import { inngest } from "@/lib/inngest/client";
import { getSupabaseAdmin } from "@/lib/supabase";
import { realFindAllClient, isFinished } from "@/lib/parallel";
import { realPdlClient } from "@/lib/pdl";
import { checkStaff, collectRun, discoveryWeek, getDiscoverySettings, getThesis, listTheses, savePreview, startPreview, startWeek, type ThesisStep } from "@/lib/discovery";

/**
 * Discovery, weekly. Sunday 10pm Montreal so candidates are ready Monday.
 * Also runs on demand ("discovery/run") for the dry run on one thesis; a
 * manual run ignores the pause switch but never the caps.
 *
 * Steps: start (caps checked per call) → wait for each run, polling every
 * 5 minutes for up to 3 hours → collect (bill, dedupe, store) → staff (PDL).
 */
export const discoveryWeeklyJob = inngest.createFunction(
  {
    id: "discovery-weekly",
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=America/Toronto 0 22 * * 0" }, { event: "discovery/run" }],
  },
  async ({ event, step }) => {
    const data = (event?.data ?? {}) as { thesisId?: string; matchLimit?: number; manual?: boolean };
    const manual = !!data.manual;
    const week = await step.run("week", () => discoveryWeek());

    const plan = await step.run("start", async () => {
      const settings = await getDiscoverySettings();
      if (settings.paused && !manual) return { paused: true as const, steps: [] as ThesisStep[] };
      const theses = await listTheses();
      const steps = await startWeek({ client: realFindAllClient(), week, settings, theses, onlyThesisId: data.thesisId, matchLimit: data.matchLimit });
      return { paused: false as const, steps };
    });
    if (plan.paused) {
      await step.run("note-paused", () => saveLastRun({ week, at: new Date().toISOString(), summary: "Paused: nothing ran." }));
      return { week, paused: true };
    }

    const started = plan.steps.filter((s) => s.action !== "skip" && s.findallId);
    const pending = new Set(started.map((s) => s.findallId!));
    for (let i = 0; i < 36 && pending.size > 0; i++) {
      await step.sleep(`wait-${i}`, "5m");
      const done = await step.run(`poll-${i}`, async () => {
        const client = realFindAllClient();
        const finished: string[] = [];
        for (const id of pending) {
          const run = await client.getRun(id).catch(() => null);
          if (run && isFinished(run)) finished.push(id);
        }
        return finished;
      });
      for (const id of done) pending.delete(id);
    }

    const collected: Array<{ name: string; matched: number; billed: number; stored: number; inSalesforce: number; note?: string }> = [];
    for (const s of started) {
      const r = await step.run(`collect-${s.thesisId}`, async () => {
        const thesis = await getThesis(s.thesisId);
        if (!thesis) return { name: s.name, matched: 0, billed: 0, stored: 0, inSalesforce: 0, note: "thesis deleted" };
        // Still running after 3 hours: take what it has so far; the rest is collected next week.
        const res = await collectRun({ client: realFindAllClient(), thesis, week, settings: await getDiscoverySettings() });
        return { name: s.name, ...res, note: pending.has(s.findallId!) ? "still running, partial results" : undefined };
      });
      collected.push(r);
    }

    const staff = await step.run("staff", async () => {
      try {
        return await checkStaff({ client: realPdlClient(), week, settings: await getDiscoverySettings() });
      } catch (err) {
        return { checked: 0, skipped: 0, error: err instanceof Error ? err.message : "PDL failed" };
      }
    });

    const skipped = plan.steps.filter((s) => s.action === "skip").map((s) => `${s.name}: ${s.reason}`);
    const summary = [
      ...collected.map((c) => `${c.name}: ${c.stored} new, ${c.inSalesforce} already in Salesforce, ${c.billed} billed${c.note ? ` (${c.note})` : ""}`),
      ...skipped.map((s) => `Skipped ${s}`),
      `Staff checked for ${staff.checked}${staff.skipped ? `, ${staff.skipped} over the PDL credit cap` : ""}${"error" in staff && staff.error ? ` (${staff.error})` : ""}`,
    ].join(" · ");
    await step.run("note", () => saveLastRun({ week, at: new Date().toISOString(), summary }));
    return { week, collected, staff, skipped };
  },
);

/** $0.10 preview of one thesis, on demand from the Discovery page. */
export const discoveryPreviewJob = inngest.createFunction(
  { id: "discovery-preview", retries: 0, concurrency: { limit: 1 }, triggers: [{ event: "discovery/preview" }] },
  async ({ event, step }) => {
    const { thesisId } = event.data as { thesisId: string };
    const findallId = await step.run("start", async () => {
      const thesis = await getThesis(thesisId);
      if (!thesis) throw new Error("Thesis not found");
      return startPreview(realFindAllClient(), thesis);
    });
    for (let i = 0; i < 12; i++) {
      await step.sleep(`wait-${i}`, "1m");
      const done = await step.run(`poll-${i}`, async () => isFinished(await realFindAllClient().getRun(findallId)));
      if (done) break;
    }
    return step.run("save", async () => {
      const thesis = await getThesis(thesisId);
      if (!thesis) return null;
      return savePreview(realFindAllClient(), thesis, findallId);
    });
  },
);

async function saveLastRun(value: { week: string; at: string; summary: string }): Promise<void> {
  await getSupabaseAdmin().from("app_settings").upsert({ key: "discovery_last_run", value, updated_at: new Date().toISOString() }, { onConflict: "key" });
}
