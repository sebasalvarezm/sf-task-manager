/**
 * "Submit Monday" for Open Tasks.
 *
 * An RCE code on a task due in a future week is not recorded in Salesforce
 * today. On submit it is saved here (on the server, not in the browser) and
 * the account is added to that week's Weekly Outreach straight away, so the
 * row is ready. At 7am Montreal on that week's Monday the Salesforce part
 * runs: the task is completed that day and the next one created that day plus
 * the RCE days, exactly as if Seb had pressed Apply that Monday.
 *
 * Every other action (and RCEs on this week's or overdue tasks) still applies
 * immediately through /api/salesforce/actions.
 *
 * Safety:
 * - Seb's click on Submit is the approval; nothing else creates an entry.
 * - Before recording, each task is re-read: if it was closed, deleted or its
 *   due date changed since it was scheduled, it is skipped, never forced.
 * - At most RUN_CAP entries are recorded per run; the rest wait for the next
 *   daily run. A pause switch stops the scheduled run (Record now still works).
 * - Scheduling the same task twice replaces the first entry, never doubles it.
 *
 * Storage: app_settings "scheduled_task_actions" (no new table to create),
 * written with an updated_at check so two writers never overwrite each other.
 */
import { getSupabaseAdmin } from "./supabase";
import { assertSalesforceId, sfQuery } from "./sf-query";
import { getValidCredentials } from "./token-manager";
import { completeAndReschedule, logAction } from "./salesforce";
import { resolveWeeklyAccountsByIds, upsertWeeklyOutreachItem } from "./weekly-outreach";
import {
  MAX_ATTEMPTS,
  RUN_CAP,
  dueItems,
  mergeScheduled,
  montrealToday,
  pruneOld,
  shortDay,
  splitForSchedule,
  stillAsScheduled,
  type QueuedAction,
  type ScheduledItem,
  type ScheduledSettings,
  type ScheduledStatus,
} from "./scheduled-actions-core";

export * from "./scheduled-actions-core";

const STORE_KEY = "scheduled_task_actions";
const SETTINGS_KEY = "scheduled_task_actions_settings";

// ── Storage ──────────────────────────────────────────────────────────────────

type Stored = { items: ScheduledItem[] };

async function read(): Promise<{ value: Stored; updatedAt: string | null }> {
  const { data, error } = await getSupabaseAdmin().from("app_settings").select("value, updated_at").eq("key", STORE_KEY).maybeSingle();
  if (error) throw new Error(`Could not read scheduled actions: ${error.message}`);
  const items = Array.isArray((data?.value as Stored | undefined)?.items) ? (data!.value as Stored).items : [];
  return { value: { items }, updatedAt: (data?.updated_at as string | undefined) ?? null };
}

/**
 * Read, change, write back, only if nobody wrote in between; otherwise read
 * again and redo the change. Returns what was written.
 */
async function update(change: (items: ScheduledItem[]) => ScheduledItem[]): Promise<ScheduledItem[]> {
  const supabase = getSupabaseAdmin();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value, updatedAt } = await read();
    const items = pruneOld(change(value.items));
    if (updatedAt === null) {
      const { error } = await supabase.from("app_settings").insert({ key: STORE_KEY, value: { items } });
      if (!error) return items;
      continue; // someone created it first: read again
    }
    const { data, error } = await supabase
      .from("app_settings")
      .update({ value: { items }, updated_at: new Date().toISOString() })
      .eq("key", STORE_KEY)
      .eq("updated_at", updatedAt)
      .select("key");
    if (error) throw new Error(`Could not save scheduled actions: ${error.message}`);
    if (data && data.length === 1) return items;
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  throw new Error("Could not save scheduled actions: the list kept changing. Try again.");
}

export async function listScheduled(): Promise<ScheduledItem[]> {
  return (await read()).value.items;
}

export async function getScheduledSettings(): Promise<ScheduledSettings> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  return { paused: (data?.value as ScheduledSettings | undefined)?.paused === true };
}

export async function saveScheduledSettings(paused: boolean): Promise<ScheduledSettings> {
  const value = { paused };
  const { error } = await getSupabaseAdmin().from("app_settings").upsert({ key: SETTINGS_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return value;
}

// ── Salesforce reads ─────────────────────────────────────────────────────────

type TaskState = { Id: string; IsClosed: boolean; ActivityDate: string | null };

async function readTasks(taskIds: string[]): Promise<Map<string, TaskState>> {
  const out = new Map<string, TaskState>();
  const ids = [...new Set(taskIds)].map((id) => assertSalesforceId(id, "task id"));
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const rows = await sfQuery<TaskState>(`SELECT Id, IsClosed, ActivityDate FROM Task WHERE Id IN (${chunk.map((id) => `'${id}'`).join(",")})`);
    for (const r of rows) {
      out.set(r.Id, r);
      out.set(r.Id.slice(0, 15), r); // a 15-character id from older data still finds its task
    }
  }
  return out;
}

// ── Schedule ─────────────────────────────────────────────────────────────────

export type ScheduleResult = {
  scheduled: Array<{ taskId: string; accountName: string | null; runOn: string }>;
  /** "changed": the task moved or closed in Salesforce, so it is stale. "not_future": it belongs to this week now; apply it normally. */
  rejected: Array<{ taskId: string; accountName: string | null; reason: string; code: "changed" | "not_future" }>;
  weeklyWarnings: string[];
};

/** Saves future-week RCEs for their Monday and adds their Weekly Outreach rows now. */
export async function scheduleActions(actions: QueuedAction[], now = new Date()): Promise<ScheduleResult> {
  if (!(await getValidCredentials())) throw new Error("NOT_CONNECTED");
  const { later, now: notForLater } = splitForSchedule(actions, now);
  const result: ScheduleResult = { scheduled: [], rejected: [], weeklyWarnings: [] };
  for (const a of notForLater) {
    result.rejected.push({ taskId: a.taskId, accountName: a.accountName, reason: "its week has started, so it was left in your queue to apply now", code: "not_future" });
  }
  if (later.length === 0) return result;

  // The task must still be open on the date it showed when it was marked.
  const tasks = await readTasks(later.map((a) => a.taskId));
  const ok = later.filter((a) => {
    const why = stillAsScheduled(a, tasks.get(a.taskId));
    if (why) result.rejected.push({ taskId: a.taskId, accountName: a.accountName, reason: why, code: "changed" });
    return !why;
  });
  if (ok.length === 0) return result;

  // Weekly Outreach rows for each Monday, made now so the list is ready.
  // An existing row (added by hand, say) is linked, never overwritten.
  const accounts = await resolveWeeklyAccountsByIds(ok.map((a) => a.accountId!));
  const supabase = getSupabaseAdmin();
  const createdAt = now.toISOString();
  const incoming: ScheduledItem[] = [];
  for (const a of ok) {
    const item: ScheduledItem = {
      id: crypto.randomUUID(),
      taskId: a.taskId,
      accountId: a.accountId!,
      accountName: a.accountName,
      subject: a.subject,
      currentDate: a.currentDate,
      days: a.days,
      runOn: a.runOn,
      status: "scheduled",
      createdAt,
      weeklyOutreachId: null,
      weeklyRowCreated: false,
    };
    try {
      const { data: existing } = await supabase
        .from("weekly_outreach")
        .select("id")
        .eq("week_start", a.runOn)
        .eq("sf_account_id", a.accountId!)
        .eq("outreach_type", "RCE")
        .maybeSingle();
      if (existing?.id) {
        item.weeklyOutreachId = existing.id as string;
      } else {
        const account = accounts.get(a.accountId!);
        if (!account) throw new Error("Salesforce account was not found");
        const row = await upsertWeeklyOutreachItem({ weekStart: a.runOn, outreachType: "RCE", account, source: "tasks", sourceReference: a.taskId, rceDays: a.days });
        item.weeklyOutreachId = row.id;
        item.weeklyRowCreated = true;
      }
    } catch (err) {
      // The Salesforce part still happens on Monday; the row is retried then.
      result.weeklyWarnings.push(`${a.accountName ?? "Account"}: ${err instanceof Error ? err.message : "could not add to Weekly Outreach"}`);
    }
    incoming.push(item);
  }
  await update((items) => mergeScheduled(items, incoming));
  result.scheduled = incoming.map((i) => ({ taskId: i.taskId, accountName: i.accountName, runOn: i.runOn }));
  return result;
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/**
 * Takes entries off the schedule. The Weekly Outreach row is removed only when
 * scheduling created it and nothing has been done on it yet (no draft, still
 * queued); otherwise it stays and the note says so.
 */
export async function cancelScheduled(ids: string[]): Promise<{ cancelled: number; rowsKept: string[] }> {
  const wanted = new Set(ids);
  const supabase = getSupabaseAdmin();
  const before = (await read()).value.items.filter((i) => wanted.has(i.id) && i.status === "scheduled");
  const rowsKept: string[] = [];
  const notes = new Map<string, string>();
  for (const item of before) {
    if (!item.weeklyOutreachId || !item.weeklyRowCreated) continue;
    const { data: row } = await supabase.from("weekly_outreach").select("id, status, draft").eq("id", item.weeklyOutreachId).maybeSingle();
    if (!row) continue;
    if (row.status === "queued" && !row.draft) {
      await supabase.from("weekly_outreach").delete().eq("id", item.weeklyOutreachId).eq("status", "queued");
    } else {
      rowsKept.push(item.accountName ?? "Account");
      notes.set(item.id, "Cancelled. The Weekly Outreach row was kept because work had started on it.");
    }
  }
  const finishedAt = new Date().toISOString();
  await update((items) =>
    items.map((i) => (wanted.has(i.id) && i.status === "scheduled" ? { ...i, status: "cancelled", finishedAt, note: notes.get(i.id) ?? "Cancelled." } : i)),
  );
  return { cancelled: before.length, rowsKept };
}

// ── Record in Salesforce ─────────────────────────────────────────────────────

export type RunSummary = { recorded: number; skipped: number; failed: number; paused?: boolean; left: number };

/**
 * Records due entries in Salesforce. `ids` limits it to those entries and
 * ignores their Monday ("Record now"); `respectPause` is set by the scheduled
 * run only.
 */
export async function runScheduled(opts: { ids?: string[]; respectPause?: boolean; now?: Date } = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  if (opts.respectPause && (await getScheduledSettings()).paused) {
    const waiting = (await listScheduled()).filter((i) => i.status === "scheduled").length;
    return { recorded: 0, skipped: 0, failed: 0, paused: true, left: waiting };
  }
  const all = (await read()).value.items;
  const picked = opts.ids
    ? all.filter((i) => i.status === "scheduled" && opts.ids!.includes(i.id)).slice(0, RUN_CAP)
    : dueItems(all, montrealToday(now));
  const summary: RunSummary = { recorded: 0, skipped: 0, failed: 0, left: 0 };
  if (picked.length === 0) {
    summary.left = all.filter((i) => i.status === "scheduled").length;
    return summary;
  }

  const tasks = await readTasks(picked.map((i) => i.taskId));
  const supabase = getSupabaseAdmin();
  for (const item of picked) {
    let status: ScheduledStatus = "done";
    let note = "";
    let weeklyOutreachId = item.weeklyOutreachId ?? null;
    const why = stillAsScheduled(item, tasks.get(item.taskId));
    if (why) {
      status = "skipped";
      note = `${why} Nothing was recorded.`;
    } else {
      try {
        await completeAndReschedule(item.taskId, item.accountId, item.subject, item.days);
        note = `Recorded in Salesforce on ${shortDay(montrealToday(now))}; next task in ${item.days} days.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Salesforce refused the change.";
        status = "failed";
        if (/Could not create new task/i.test(message)) {
          // The task was completed; only the next one is missing. Never retried, so it is not completed twice.
          note = `The task was completed, but the next task could not be created (${message}). Create it by hand in Salesforce.`;
        } else if ((item.attempts ?? 0) + 1 < MAX_ATTEMPTS) {
          status = "scheduled";
          note = `Salesforce refused it (${message}). It will be tried again on the next run.`;
        } else {
          note = `Salesforce refused it ${MAX_ATTEMPTS} times (${message}). Nothing was recorded.`;
        }
      }
      await logAction({
        taskId: item.taskId,
        accountName: item.accountName,
        actionType: "complete_reschedule",
        daysUsed: item.days,
        oldDate: item.currentDate,
        success: status === "done",
        errorMessage: status === "done" ? undefined : note,
      });
      // A row that could not be made when scheduling is made now.
      if (status === "done" && !weeklyOutreachId) {
        try {
          const accounts = await resolveWeeklyAccountsByIds([item.accountId]);
          const account = accounts.get(item.accountId);
          if (account) {
            const { data: existing } = await supabase.from("weekly_outreach").select("id").eq("week_start", item.runOn).eq("sf_account_id", item.accountId).eq("outreach_type", "RCE").maybeSingle();
            weeklyOutreachId = (existing?.id as string | undefined) ?? (await upsertWeeklyOutreachItem({ weekStart: item.runOn, outreachType: "RCE", account, source: "tasks", sourceReference: item.taskId, rceDays: item.days })).id;
          }
        } catch {
          note += " Could not add it to Weekly Outreach; add it by hand.";
        }
      }
    }
    if (status === "done") summary.recorded++;
    else if (status === "skipped") summary.skipped++;
    else summary.failed++;
    // Saved after every entry: a run cut short never records one twice
    // (a re-run re-reads the task, which is closed by then, and skips it).
    const finishedAt = status === "scheduled" ? undefined : new Date().toISOString();
    const attempts = status === "scheduled" || status === "failed" ? (item.attempts ?? 0) + 1 : item.attempts;
    const lastTriedOn = status === "scheduled" ? montrealToday(now) : item.lastTriedOn;
    await update((items) => items.map((i) => (i.id === item.id && i.status === "scheduled" ? { ...i, status, note, finishedAt, weeklyOutreachId, attempts, lastTriedOn } : i)));
  }
  summary.left = (await listScheduled()).filter((i) => i.status === "scheduled").length;
  return summary;
}
