/**
 * The pure part of Open Tasks "Submit Monday": types, dates and list rules.
 * No server imports, so the Open Tasks page uses the same rules as the server
 * (which week an RCE waits for, what a Monday is). See lib/scheduled-actions.ts.
 */
import { addDays, format } from "date-fns";

/** Entries recorded per call: about 2 seconds each, well inside the 5 minute limit. */
export const RUN_CAP = 60;
export const MAX_ATTEMPTS = 3;
/** Finished entries are kept this long so the page can show what happened. */
export const KEEP_DONE_DAYS = 21;

/** The action shape Open Tasks sends (same as /api/salesforce/actions). */
export type QueuedAction = {
  taskId: string;
  accountId: string | null;
  accountName: string | null;
  subject: string;
  currentDate: string;
  actionType: "none" | "hard_delete" | "complete_reschedule" | "delay";
  days: number;
};

export type ScheduledStatus = "scheduled" | "done" | "skipped" | "failed" | "cancelled";

export type ScheduledItem = {
  id: string;
  taskId: string;
  accountId: string;
  accountName: string | null;
  subject: string;
  /** The task's due date when it was scheduled; recording is skipped if it moved. */
  currentDate: string;
  days: number;
  /** Monday the Salesforce part runs (Montreal date). */
  runOn: string;
  status: ScheduledStatus;
  createdAt: string;
  finishedAt?: string;
  note?: string;
  weeklyOutreachId?: string | null;
  /** True when scheduling created the Weekly Outreach row, so Cancel may remove it. */
  weeklyRowCreated?: boolean;
  /** Recording attempts that hit a Salesforce error; retried on the next daily run up to MAX_ATTEMPTS. */
  attempts?: number;
  /** Montreal date of the last failed attempt, so a retry waits for the next day. */
  lastTriedOn?: string;
};

export type ScheduledSettings = { paused: boolean };

// ── Dates (pure) ─────────────────────────────────────────────────────────────

/** Today's date in Montreal, "YYYY-MM-DD", whatever the server's clock zone. */
export function montrealToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The Monday of the week a date falls in ("2026-11-12" -> "2026-11-09"). */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** "Mon, Nov 9" for the button and the row labels. */
export function shortDay(date: string): string {
  return format(new Date(`${date}T12:00:00`), "EEE, MMM d");
}

/**
 * Which queued actions wait for Monday: RCE codes (complete and recreate) on a
 * task due in a week after this one. Everything else applies now.
 */
export function splitForSchedule<T extends QueuedAction>(actions: T[], now = new Date()): { now: T[]; later: Array<T & { runOn: string }> } {
  const thisMonday = mondayOf(montrealToday(now));
  const out = { now: [] as T[], later: [] as Array<T & { runOn: string }> };
  for (const a of actions) {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(a.currentDate ?? "");
    const runOn = valid ? mondayOf(a.currentDate) : "";
    if (a.actionType === "complete_reschedule" && a.accountId && valid && runOn > thisMonday) out.later.push({ ...a, runOn });
    else out.now.push(a);
  }
  return out;
}

// ── List handling (pure) ─────────────────────────────────────────────────────

/** Adds new entries; a task already waiting is replaced (new days or date), never doubled. */
export function mergeScheduled(items: ScheduledItem[], incoming: ScheduledItem[]): ScheduledItem[] {
  const replacing = new Set(incoming.map((i) => i.taskId));
  return [...items.filter((i) => !(i.status === "scheduled" && replacing.has(i.taskId))), ...incoming];
}

/** Entries whose Monday has come, oldest first, up to the cap. */
export function dueItems(items: ScheduledItem[], today: string, cap = RUN_CAP): ScheduledItem[] {
  return items
    .filter((i) => i.status === "scheduled" && i.runOn <= today && i.lastTriedOn !== today)
    .sort((a, b) => a.runOn.localeCompare(b.runOn) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, cap);
}

/** Drops finished entries older than KEEP_DONE_DAYS. Waiting ones are always kept. */
export function pruneOld(items: ScheduledItem[], now = new Date()): ScheduledItem[] {
  const cutoff = addDays(now, -KEEP_DONE_DAYS).toISOString();
  return items.filter((i) => i.status === "scheduled" || (i.finishedAt ?? i.createdAt) >= cutoff);
}

/** Whether a task, as Salesforce has it now, is still the one that was scheduled. */
export function stillAsScheduled(item: Pick<ScheduledItem, "currentDate">, task: { IsClosed: boolean; ActivityDate: string | null } | undefined): string | null {
  if (!task) return "The task no longer exists in Salesforce.";
  if (task.IsClosed) return "The task was already completed in Salesforce.";
  if (task.ActivityDate !== item.currentDate) return `The task's due date changed in Salesforce (${item.currentDate} to ${task.ActivityDate ?? "none"}).`;
  return null;
}

