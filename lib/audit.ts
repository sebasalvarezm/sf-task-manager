/**
 * The weekly check: a read-only sweep of real data for the kinds of mistakes
 * found by hand in Oct/Nov 2026 (drafts addressed to colleagues, banned
 * wording, RCEs logged by nudges, drafts marked sent but never sent, call
 * preps with an empty history, failed or slow background jobs).
 *
 * It never writes to Salesforce, Outlook or Outreach. Its only write is the
 * report itself (app_settings "audit_last"). Hard caps: two Salesforce
 * queries, at most MAX_OUTLOOK_CHECKS Outlook reads, no model calls. Paused
 * from the page with the "audit_settings" switch.
 */
import { addDays, format } from "date-fns";
import { getSupabaseAdmin } from "./supabase";
import { getValidCredentials } from "./token-manager";
import { assertSalesforceId, sfQuery } from "./sf-query";
import { bannedLeft } from "./email-words";
import { isInternalAddress } from "./rce-thread-match";
import { isNudgeRecord, type CompletedRow } from "./nudge-cleanup";
import { readWeeklyOutreachSourceMetadata, type WeeklyOutreachItem } from "./weekly-outreach";
import { outlookMessageState } from "./microsoft";

export const MAX_OUTLOOK_CHECKS = 60;
const SETTINGS_KEY = "audit_settings";
const REPORT_KEY = "audit_last";

export type AuditItem = { label: string; detail: string; href?: string };
export type AuditCheck = {
  key: string;
  title: string;
  /** What a clean result means, shown when there is nothing to fix. */
  okText: string;
  items: AuditItem[];
  /** Informational lines that are not problems (speed summary). */
  notes?: string[];
  /** Set when the check could not run (not connected, query failed). */
  skipped?: string;
};
export type AuditReport = { at: string; ms: number; issues: number; checks: AuditCheck[] };
export type AuditSettings = { paused: boolean };

// ── Pure checks (tested) ─────────────────────────────────────────────────────

type WoRow = Pick<WeeklyOutreachItem, "id" | "account_name" | "status" | "draft" | "week_start" | "outreach_type"> & { source_reference: string | null };
const WEEKLY = (_r: WoRow) => "/weekly-outreach";
const UNSENT_WO = new Set(["draft_ready", "approved", "queued", "needs_context"]);

/** RCE drafts addressed to a Valstone colleague. */
export function checkColleagueRecipients(rows: WoRow[]): AuditItem[] {
  return rows.flatMap((r) => {
    const meta = readWeeklyOutreachSourceMetadata(r.source_reference);
    const internal = (meta.recipients ?? []).map((x) => x.email).filter((e) => isInternalAddress(e));
    return internal.length && r.status !== "sent"
      ? [{ label: r.account_name, detail: `Week of ${r.week_start}: addressed to ${internal.join(", ")}`, href: WEEKLY(r) }]
      : [];
  });
}

/** Unsent drafts (Weekly Outreach and the E1 send queue) that still contain banned wording. */
export function checkWording(
  rows: WoRow[],
  sends: Array<{ id: string; account_name: string; status: string; body: string | null; subject: string | null; week_start: string }>,
): AuditItem[] {
  const fromRows = rows
    .filter((r) => UNSENT_WO.has(r.status) && typeof r.draft === "string" && r.draft)
    .flatMap((r) => {
      const hits = bannedLeft(r.draft as string);
      return hits.length ? [{ label: r.account_name, detail: `${r.outreach_type} draft, week of ${r.week_start}: ${hits.join(", ")}`, href: WEEKLY(r) }] : [];
    });
  const fromSends = sends
    .filter((s) => ["pending", "review", "ready", "approved"].includes(s.status) && (s.body || s.subject))
    .flatMap((s) => {
      const hits = bannedLeft(`${s.subject ?? ""}\n${s.body ?? ""}`);
      return hits.length ? [{ label: s.account_name, detail: `E1 in the send queue: ${hits.join(", ")}`, href: "/send" }] : [];
    });
  return [...fromRows, ...fromSends];
}

/** Rows marked sent whose Outlook draft is still sitting unsent. */
export function checkStuckDrafts(rows: WoRow[], state: Map<string, "draft" | "sent" | "gone">): AuditItem[] {
  return rows.flatMap((r) => {
    const id = readWeeklyOutreachSourceMetadata(r.source_reference).outlookDraftId;
    return r.status === "sent" && id && state.get(id) === "draft"
      ? [{ label: r.account_name, detail: `Marked sent (week of ${r.week_start}), but the Outlook draft was never sent`, href: WEEKLY(r) }]
      : [];
  });
}

/** Completed RCEs that a nudge or follow-up logged (only RCE codes should). */
export function checkFalseRces(completed: CompletedRow[], sfBase: string): AuditItem[] {
  return completed.filter(isNudgeRecord).map((r) => ({
    label: r.Account?.Name ?? "Account",
    detail: `Completed RCE on ${r.ActivityDate ?? r.LastModifiedDate.slice(0, 10)} that came from a nudge, not an RCE code`,
    href: r.AccountId ? `${sfBase}/${r.AccountId}` : undefined,
  }));
}

type OpenTask = { Id: string; AccountId: string | null; Subject: string | null; ActivityDate: string | null; Account?: { Name?: string } | null };
/** Accounts with more than one open RCE task: there should be one, pushed forward. */
export function checkDuplicateOpenTasks(open: OpenTask[], sfBase: string): AuditItem[] {
  const by = new Map<string, OpenTask[]>();
  for (const t of open) if (t.AccountId) by.set(t.AccountId, [...(by.get(t.AccountId) ?? []), t]);
  return [...by.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({
      label: list[0].Account?.Name ?? "Account",
      detail: `${list.length} open RCE tasks (${list.map((t) => t.ActivityDate ?? "no date").sort().join(", ")})`,
      href: `${sfBase}/${id}`,
    }));
}

type JobRow = { id: string; kind: string; status: string; label: string | null; error: string | null; result?: Record<string, unknown> | null; started_at: string | null; completed_at: string | null; created_at: string };

/** Call preps whose Company History has no year or says the facts are unavailable. */
export function checkPrepHistory(jobs: JobRow[]): AuditItem[] {
  return jobs
    .filter((j) => j.kind === "prep" && j.status === "succeeded")
    .flatMap((j) => {
      const history = String(((j.result?.onePager ?? {}) as { companyHistory?: unknown }).companyHistory ?? "");
      const thin = !/\b(18|19|20)\d{2}\b/.test(history) || /not available|supplied evidence|not confirmed/i.test(history);
      return thin ? [{ label: j.label ?? "Call prep", detail: "Company History has no founding year or says facts are not available", href: "/prep" }] : [];
    });
}

const KIND_NAME: Record<string, string> = {
  prep: "Call prep", sourcing: "Sourcing", sourcing_bulk: "Bulk sourcing", calls_log: "Call logger", outreach_screen: "Outreach screen",
  e1_prepare: "E1 prepare", e1_schedule: "E1 schedule", accounts_enrich: "Account enrich", trip_search: "Trip search", trip_geocode: "Trip geocode",
  outcomes_build: "What gets replies", task_bulk: "Task bulk",
};
const kindName = (k: string) => KIND_NAME[k] ?? k;

export function checkFailedJobs(jobs: JobRow[]): AuditItem[] {
  return jobs
    .filter((j) => j.status === "failed")
    .map((j) => ({ label: `${kindName(j.kind)}${j.label ? `: ${j.label}` : ""}`, detail: (j.error ?? "Failed with no message").replace(/\s+/g, " ").slice(0, 160) }));
}

/** Seconds a job of this kind may take before it counts as slow. */
const SLOW_AFTER: Record<string, number> = { prep: 240, sourcing: 900, sourcing_bulk: 1800, calls_log: 300, outreach_screen: 1800, e1_prepare: 600, e1_schedule: 600 };

export function speedCheck(jobs: JobRow[]): { items: AuditItem[]; notes: string[] } {
  const by = new Map<string, number[]>();
  for (const j of jobs) {
    if (j.status !== "succeeded" || !j.started_at || !j.completed_at) continue;
    const s = (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000;
    if (s >= 0) by.set(j.kind, [...(by.get(j.kind) ?? []), s]);
  }
  const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
  const notes: string[] = [];
  const items: AuditItem[] = [];
  for (const [kind, list] of [...by.entries()].sort()) {
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    const max = sorted[sorted.length - 1];
    notes.push(`${kindName(kind)}: ${sorted.length} run${sorted.length !== 1 ? "s" : ""}, typical ${fmt(median)}, slowest ${fmt(max)}`);
    const limit = SLOW_AFTER[kind] ?? 600;
    const slow = sorted.filter((s) => s > limit).length;
    if (slow > 0) items.push({ label: kindName(kind), detail: `${slow} run${slow !== 1 ? "s" : ""} over ${fmt(limit)} (slowest ${fmt(max)})` });
  }
  return { items, notes };
}

// ── Settings and report storage ──────────────────────────────────────────────

export async function getAuditSettings(): Promise<AuditSettings> {
  try {
    const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
    return { paused: (data?.value as AuditSettings | undefined)?.paused === true };
  } catch {
    return { paused: false };
  }
}

export async function saveAuditSettings(settings: AuditSettings): Promise<AuditSettings> {
  const value = { paused: settings.paused === true };
  await getSupabaseAdmin().from("app_settings").upsert({ key: SETTINGS_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return value;
}

export async function getLastReport(): Promise<AuditReport | null> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", REPORT_KEY).maybeSingle();
  return (data?.value as AuditReport | undefined) ?? null;
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runAudit(now = new Date()): Promise<AuditReport> {
  const started = Date.now();
  const supabase = getSupabaseAdmin();
  const since = addDays(now, -8).toISOString();
  const fourWeeksAgo = format(addDays(now, -35), "yyyy-MM-dd");
  const thisWeekAndLast = format(addDays(now, -14), "yyyy-MM-dd");
  const checks: AuditCheck[] = [];

  const { data: woData } = await supabase
    .from("weekly_outreach")
    .select("id, account_name, status, draft, week_start, outreach_type, source_reference")
    .gte("week_start", fourWeeksAgo)
    .limit(2000);
  const wo = (woData ?? []) as WoRow[];
  const recent = wo.filter((r) => r.week_start >= thisWeekAndLast);
  const { data: sendData } = await supabase
    .from("e1_sends")
    .select("id, account_name, status, body, subject, week_start")
    .gte("week_start", thisWeekAndLast)
    .limit(1000);

  checks.push({ key: "colleague", title: "RCE drafts addressed to a colleague", okText: "Every RCE draft goes to someone outside Valstone.", items: checkColleagueRecipients(recent) });
  checks.push({ key: "wording", title: "Drafts with banned wording", okText: "No unsent draft uses a banned word or phrase.", items: checkWording(recent, (sendData ?? []) as Parameters<typeof checkWording>[1]) });

  // Outlook: only rows marked sent that still point at a draft, newest first, capped.
  const stuckCandidates = wo
    .filter((r) => r.status === "sent" && readWeeklyOutreachSourceMetadata(r.source_reference).outlookDraftId)
    .sort((a, b) => b.week_start.localeCompare(a.week_start))
    .slice(0, MAX_OUTLOOK_CHECKS);
  const stuck: AuditCheck = { key: "stuck", title: "Marked sent, never sent", okText: "Every RCE marked sent left your Outbox.", items: [] };
  try {
    const state = new Map<string, "draft" | "sent" | "gone">();
    for (const r of stuckCandidates) {
      const id = readWeeklyOutreachSourceMetadata(r.source_reference).outlookDraftId!;
      state.set(id, await outlookMessageState(id));
    }
    stuck.items = checkStuckDrafts(stuckCandidates, state);
  } catch (err) {
    stuck.skipped = err instanceof Error && err.message === "MS_NOT_CONNECTED" ? "Outlook is not connected." : "Outlook could not be read.";
  }
  checks.push(stuck);

  const rces: AuditCheck = { key: "rce", title: "RCEs logged by a nudge or follow-up", okText: "Only RCE codes logged RCEs this week.", items: [] };
  const dupes: AuditCheck = { key: "dupes", title: "Accounts with two open RCE tasks", okText: "Each account has at most one open RCE task.", items: [] };
  try {
    const creds = await getValidCredentials();
    if (!creds) throw new Error("NOT_CONNECTED");
    const me = assertSalesforceId(creds.salesforce_user_id ?? "", "user id");
    const base = creds.instance_url.replace(/\/$/, "");
    const completed = await sfQuery<CompletedRow>(
      `SELECT Id, Subject, Type, Description, AccountId, Account.Name, LastModifiedDate, ActivityDate FROM Task ` +
        `WHERE OwnerId = '${me}' AND Status = 'Completed' AND Subject_Type__c = 'RCE1' AND LastModifiedDate = LAST_N_DAYS:8 LIMIT 1000`,
      creds,
    );
    rces.items = checkFalseRces(completed, base);
    const open = await sfQuery<OpenTask>(
      `SELECT Id, AccountId, Account.Name, Subject, ActivityDate FROM Task ` +
        `WHERE OwnerId = '${me}' AND IsClosed = false AND AccountId != null AND Subject_Type__c LIKE '%RCE%' LIMIT 3000`,
      creds,
    );
    dupes.items = checkDuplicateOpenTasks(open, base);
  } catch (err) {
    const why = err instanceof Error && err.message === "NOT_CONNECTED" ? "Salesforce is not connected." : "Salesforce could not be read.";
    rces.skipped = why;
    dupes.skipped = why;
  }
  checks.push(rces, dupes);

  const { data: jobData } = await supabase
    .from("jobs")
    .select("id, kind, status, label, error, result, started_at, completed_at, created_at")
    .gte("created_at", since)
    .in("status", ["succeeded", "failed"])
    .limit(1000);
  const jobs = (jobData ?? []) as JobRow[];
  checks.push({ key: "prep", title: "Call preps with a thin Company History", okText: "Every call prep this week has a founding year.", items: checkPrepHistory(jobs) });
  checks.push({ key: "failed", title: "Background jobs that failed", okText: "No background job failed this week.", items: checkFailedJobs(jobs) });
  const speed = speedCheck(jobs);
  checks.push({ key: "speed", title: "Slow background jobs", okText: "Every background job finished in normal time.", items: speed.items, notes: speed.notes });

  const report: AuditReport = {
    at: now.toISOString(),
    ms: Date.now() - started,
    issues: checks.reduce((n, c) => n + c.items.length, 0),
    checks,
  };
  await supabase.from("app_settings").upsert({ key: REPORT_KEY, value: report, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return report;
}
