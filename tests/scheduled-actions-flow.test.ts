import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory stand-ins: nothing here touches Salesforce, Supabase or Outlook ──
type Row = Record<string, unknown>;
const db: { app_settings: Row[]; weekly_outreach: Row[] } = { app_settings: [], weekly_outreach: [] };
let clock = 0;

function table(name: keyof typeof db) {
  const filters: Array<[string, unknown]> = [];
  let mode: "select" | "update" | "delete" = "select";
  let patch: Row = {};
  const rows = () => db[name].filter((r) => filters.every(([k, v]) => r[k] === v));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push([k, v]); return api; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (row: Row) => {
      if (db[name].some((r) => r.key === row.key)) return { error: { message: "duplicate" } };
      db[name].push({ ...row, updated_at: `t${++clock}` });
      return { error: null };
    },
    upsert: async (row: Row) => {
      db[name] = db[name].filter((r) => r.key !== row.key);
      db[name].push({ ...row, updated_at: `t${++clock}` });
      return { error: null };
    },
    update: (p: Row) => { mode = "update"; patch = p; return api; },
    delete: () => { mode = "delete"; return api; },
    then: (resolve: (v: unknown) => void) => {
      if (mode === "update") {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, patch, { updated_at: `t${++clock}` }));
        resolve({ data: hit.map((r) => ({ key: r.key })), error: null });
      } else if (mode === "delete") {
        const hit = new Set(rows());
        db[name] = db[name].filter((r) => !hit.has(r));
        resolve({ error: null });
      } else resolve({ data: rows(), error: null });
    },
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (n: keyof typeof db) => table(n) }) }));

const sfTasks = new Map<string, { Id: string; IsClosed: boolean; ActivityDate: string | null }>();
const completed: Array<{ taskId: string; days: number }> = [];
let failCreate = false;
let failOther = false;
vi.mock("@/lib/sf-query", () => ({
  assertSalesforceId: (id: string) => id,
  sfQuery: async (soql: string) => [...sfTasks.values()].filter((t) => soql.includes(`'${t.Id}'`)),
}));
vi.mock("@/lib/token-manager", () => ({ getValidCredentials: async () => ({ salesforce_user_id: "005ME" }) }));
vi.mock("@/lib/salesforce", () => ({
  completeAndReschedule: async (taskId: string, _a: string, _s: string, days: number) => {
    if (failCreate) throw new Error("Could not create new task: INVALID");
    if (failOther) throw new Error("Could not mark task as completed: UNABLE_TO_LOCK_ROW");
    completed.push({ taskId, days });
    sfTasks.get(taskId)!.IsClosed = true;
  },
  logAction: async () => undefined,
}));
vi.mock("@/lib/weekly-outreach", () => ({
  resolveWeeklyAccountsByIds: async (ids: string[]) => new Map(ids.map((id) => [id, { accountId: id, accountName: `Account ${id}` }])),
  upsertWeeklyOutreachItem: async (input: { weekStart: string; account: { accountId: string }; rceDays: number }) => {
    const row = { id: `wo-${db.weekly_outreach.length + 1}`, week_start: input.weekStart, sf_account_id: input.account.accountId, outreach_type: "RCE", status: "queued", draft: null, rce_days: input.rceDays };
    db.weekly_outreach.push(row);
    return row;
  },
}));

import { cancelScheduled, listScheduled, runScheduled, saveScheduledSettings, scheduleActions } from "@/lib/scheduled-actions";

const thursday = new Date("2026-11-05T19:00:00Z");
const monday7am = new Date("2026-11-09T12:00:00Z");
const rce = (taskId: string, accountId: string, currentDate = "2026-11-11", days = 7) => ({
  taskId, accountId, accountName: `Account ${accountId}`, subject: "RCE", currentDate, actionType: "complete_reschedule" as const, days,
});

beforeEach(() => {
  db.app_settings = [];
  db.weekly_outreach = [];
  sfTasks.clear();
  completed.length = 0;
  failCreate = false;
  failOther = false;
  for (const [id, date] of [["T1", "2026-11-11"], ["T2", "2026-11-12"], ["T3", "2026-11-10"]] as const) sfTasks.set(id, { Id: id, IsClosed: false, ActivityDate: date });
});

describe("Submit Monday, end to end with stand-ins", () => {
  it("Thursday: saves the RCEs and adds next week's Weekly Outreach rows, writes nothing to Salesforce", async () => {
    const r = await scheduleActions([rce("T1", "A1"), rce("T2", "A2", "2026-11-12", 14)], thursday);
    expect(r.scheduled.map((s) => [s.taskId, s.runOn])).toEqual([["T1", "2026-11-09"], ["T2", "2026-11-09"]]);
    expect(completed).toEqual([]);
    expect(db.weekly_outreach.map((w) => [w.week_start, w.sf_account_id, w.rce_days])).toEqual([["2026-11-09", "A1", 7], ["2026-11-09", "A2", 14]]);
    expect((await listScheduled()).filter((i) => i.status === "scheduled")).toHaveLength(2);
  });

  it("an existing Weekly Outreach row is linked, never overwritten or doubled", async () => {
    db.weekly_outreach.push({ id: "mine", week_start: "2026-11-09", sf_account_id: "A1", outreach_type: "RCE", status: "draft_ready", draft: "Hi" });
    await scheduleActions([rce("T1", "A1")], thursday);
    expect(db.weekly_outreach).toHaveLength(1);
    expect((await listScheduled())[0].weeklyOutreachId).toBe("mine");
  });

  it("submitting the same task twice keeps one entry", async () => {
    await scheduleActions([rce("T1", "A1", "2026-11-11", 7)], thursday);
    await scheduleActions([rce("T1", "A1", "2026-11-11", 14)], thursday);
    const waiting = (await listScheduled()).filter((i) => i.status === "scheduled");
    expect(waiting.map((i) => i.days)).toEqual([14]);
    expect(db.weekly_outreach).toHaveLength(1);
  });

  it("refuses a task that changed since it was marked", async () => {
    sfTasks.get("T1")!.ActivityDate = "2026-12-01";
    const r = await scheduleActions([rce("T1", "A1")], thursday);
    expect(r.scheduled).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/due date changed/);
    expect(db.weekly_outreach).toHaveLength(0);
  });

  it("nothing runs before Monday; Monday 7am records each task once", async () => {
    await scheduleActions([rce("T1", "A1"), rce("T2", "A2", "2026-11-12", 14)], thursday);
    expect((await runScheduled({ respectPause: true, now: new Date("2026-11-08T12:00:00Z") })).recorded).toBe(0); // Sunday
    const s = await runScheduled({ respectPause: true, now: monday7am });
    expect(s).toMatchObject({ recorded: 2, skipped: 0, failed: 0, left: 0 });
    expect(completed).toEqual([{ taskId: "T1", days: 7 }, { taskId: "T2", days: 14 }]);
    // A second run the same morning (a retry) records nothing more.
    expect((await runScheduled({ respectPause: true, now: monday7am })).recorded).toBe(0);
    expect(completed).toHaveLength(2);
  });

  it("skips a task that was completed or moved by hand before Monday", async () => {
    await scheduleActions([rce("T1", "A1"), rce("T2", "A2", "2026-11-12")], thursday);
    sfTasks.get("T1")!.IsClosed = true;
    sfTasks.get("T2")!.ActivityDate = "2026-11-30";
    const s = await runScheduled({ respectPause: true, now: monday7am });
    expect(s).toMatchObject({ recorded: 0, skipped: 2 });
    expect(completed).toEqual([]);
  });

  it("the pause switch stops the 7am run, but Record now still works", async () => {
    await scheduleActions([rce("T1", "A1")], thursday);
    await saveScheduledSettings(true);
    expect((await runScheduled({ respectPause: true, now: monday7am })).paused).toBe(true);
    expect(completed).toEqual([]);
    const id = (await listScheduled())[0].id;
    expect((await runScheduled({ ids: [id], now: thursday })).recorded).toBe(1);
  });

  it("cancel removes the untouched row it created, and keeps one you already worked on", async () => {
    await scheduleActions([rce("T1", "A1"), rce("T2", "A2", "2026-11-12")], thursday);
    db.weekly_outreach.find((w) => w.sf_account_id === "A2")!.draft = "Hi Kim,";
    const ids = (await listScheduled()).map((i) => i.id);
    const r = await cancelScheduled(ids);
    expect(r.cancelled).toBe(2);
    expect(r.rowsKept).toEqual(["Account A2"]);
    expect(db.weekly_outreach.map((w) => w.sf_account_id)).toEqual(["A2"]);
    expect((await runScheduled({ respectPause: true, now: monday7am })).recorded).toBe(0);
  });

  it("if Salesforce completes the task but cannot create the next one, it is never retried", async () => {
    await scheduleActions([rce("T1", "A1")], thursday);
    failCreate = true;
    const s = await runScheduled({ respectPause: true, now: monday7am });
    expect(s.failed).toBe(1);
    const entry = (await listScheduled())[0];
    expect(entry.status).toBe("failed");
    expect(entry.note).toMatch(/Create it by hand/);
  });

  it("a Salesforce hiccup is retried on the next daily run, up to three times", async () => {
    await scheduleActions([rce("T1", "A1")], thursday);
    failOther = true;
    await runScheduled({ respectPause: true, now: monday7am });
    expect((await listScheduled())[0]).toMatchObject({ status: "scheduled", attempts: 1, lastTriedOn: "2026-11-09" });
    failOther = false;
    // Not retried again the same morning.
    expect((await runScheduled({ respectPause: true, now: monday7am })).recorded).toBe(0);
    const s = await runScheduled({ respectPause: true, now: new Date("2026-11-10T12:00:00Z") });
    expect(s.recorded).toBe(1);
    expect(completed).toEqual([{ taskId: "T1", days: 7 }]);
  });
});
