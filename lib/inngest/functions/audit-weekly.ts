import { inngest } from "@/lib/inngest/client";
import { getAuditSettings, runAudit } from "@/lib/audit";

/**
 * The weekly check, Sunday 7pm Montreal so the report is waiting Monday.
 * Read-only against Salesforce and Outlook (see lib/audit.ts for the caps).
 * The pause switch on /audit stops the scheduled run; "Run now" ignores it.
 */
export const auditWeeklyJob = inngest.createFunction(
  { id: "audit-weekly", retries: 1, concurrency: { limit: 1 }, triggers: [{ cron: "TZ=America/Toronto 0 19 * * 0" }] },
  async ({ step }) => {
    const settings = await step.run("settings", () => getAuditSettings());
    if (settings.paused) return { paused: true };
    const report = await step.run("run", () => runAudit());
    return { issues: report.issues, ms: report.ms };
  },
);
