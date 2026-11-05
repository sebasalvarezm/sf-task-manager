import { describe, expect, it } from "vitest";
import {
  dueItems, mergeScheduled, mondayOf, montrealToday, pruneOld, shortDay, splitForSchedule, stillAsScheduled,
  type QueuedAction, type ScheduledItem,
} from "@/lib/scheduled-actions-core";

const thursday = new Date("2026-11-05T19:00:00Z"); // Thu Nov 5, 2pm Montreal
const act = (o: Partial<QueuedAction>): QueuedAction => ({
  taskId: "00T1", accountId: "001A", accountName: "Acme", subject: "RCE", currentDate: "2026-11-11", actionType: "complete_reschedule", days: 7, ...o,
});
const item = (o: Partial<ScheduledItem>): ScheduledItem => ({
  id: "s1", taskId: "00T1", accountId: "001A", accountName: "Acme", subject: "RCE", currentDate: "2026-11-11", days: 7,
  runOn: "2026-11-09", status: "scheduled", createdAt: "2026-11-05T19:00:00.000Z", ...o,
});

describe("dates", () => {
  it("finds the Monday of any day, Sunday included", () => {
    expect(mondayOf("2026-11-09")).toBe("2026-11-09");
    expect(mondayOf("2026-11-12")).toBe("2026-11-09");
    expect(mondayOf("2026-11-15")).toBe("2026-11-09"); // Sunday belongs to the week before
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28"); // across a year end
  });
  it("uses the Montreal date, not the server's", () => {
    expect(montrealToday(new Date("2026-11-06T03:00:00Z"))).toBe("2026-11-05"); // Thu 10pm Montreal
    expect(montrealToday(thursday)).toBe("2026-11-05");
    expect(shortDay("2026-11-09")).toBe("Mon, Nov 9");
  });
});

describe("which actions wait for Monday", () => {
  it("only RCEs on next week's (or later) tasks wait; everything else applies now", () => {
    const { now, later } = splitForSchedule(
      [
        act({ taskId: "a", currentDate: "2026-11-11" }), // next week: waits for Nov 9
        act({ taskId: "b", currentDate: "2026-11-18" }), // two weeks out: waits for Nov 16
        act({ taskId: "c", currentDate: "2026-11-05" }), // this week: now
        act({ taskId: "d", currentDate: "2026-10-28" }), // overdue: now
        act({ taskId: "e", currentDate: "2026-11-11", actionType: "delay", days: 30 }), // a push: now
        act({ taskId: "f", currentDate: "2026-11-11", actionType: "hard_delete", days: 0 }), // a delete: now
        act({ taskId: "g", currentDate: "2026-11-11", accountId: null }), // no account: cannot have a Weekly Outreach row, now
      ],
      thursday,
    );
    expect(later.map((a) => [a.taskId, a.runOn])).toEqual([["a", "2026-11-09"], ["b", "2026-11-16"]]);
    expect(now.map((a) => a.taskId)).toEqual(["c", "d", "e", "f", "g"]);
  });
  it("on Sunday night, next week's tasks still wait for Monday", () => {
    const sundayNight = new Date("2026-11-09T03:30:00Z"); // Sun Nov 8, 10:30pm Montreal
    expect(splitForSchedule([act({ currentDate: "2026-11-10" })], sundayNight).later).toHaveLength(1);
    const mondayMorning = new Date("2026-11-09T13:00:00Z"); // Mon Nov 9, 8am Montreal: it is this week now
    expect(splitForSchedule([act({ currentDate: "2026-11-10" })], mondayMorning).now).toHaveLength(1);
  });
});

describe("the schedule list", () => {
  it("scheduling a task again replaces it instead of doubling it", () => {
    const merged = mergeScheduled([item({ id: "old", days: 7 })], [item({ id: "new", days: 14 })]);
    expect(merged.map((i) => [i.id, i.days])).toEqual([["new", 14]]);
  });
  it("a finished entry for the same task is kept as history", () => {
    const merged = mergeScheduled([item({ id: "old", status: "done" })], [item({ id: "new" })]);
    expect(merged.map((i) => i.id)).toEqual(["old", "new"]);
  });
  it("runs only what is due, oldest first, capped", () => {
    const list = [
      item({ id: "x", runOn: "2026-11-16" }),
      item({ id: "y", runOn: "2026-11-09", createdAt: "2026-11-06T00:00:00Z" }),
      item({ id: "z", runOn: "2026-11-09", createdAt: "2026-11-05T00:00:00Z" }),
      item({ id: "w", runOn: "2026-11-09", status: "cancelled" }),
    ];
    expect(dueItems(list, "2026-11-08").map((i) => i.id)).toEqual([]); // Sunday: nothing
    expect(dueItems(list, "2026-11-09").map((i) => i.id)).toEqual(["z", "y"]);
    expect(dueItems(list, "2026-11-10").map((i) => i.id)).toEqual(["z", "y"]); // a missed Monday is caught up
    expect(dueItems(list, "2026-11-09", 1).map((i) => i.id)).toEqual(["z"]);
  });
  it("drops old finished entries but never a waiting one", () => {
    const now = new Date("2026-12-31T12:00:00Z");
    const kept = pruneOld([item({ id: "wait", runOn: "2026-11-09" }), item({ id: "old", status: "done", finishedAt: "2026-11-09T12:00:00Z" })], now);
    expect(kept.map((i) => i.id)).toEqual(["wait"]);
  });
  it("records only a task still open on the same due date", () => {
    expect(stillAsScheduled(item({}), { IsClosed: false, ActivityDate: "2026-11-11" })).toBeNull();
    expect(stillAsScheduled(item({}), { IsClosed: true, ActivityDate: "2026-11-11" })).toMatch(/already completed/);
    expect(stillAsScheduled(item({}), { IsClosed: false, ActivityDate: "2026-12-11" })).toMatch(/due date changed/);
    expect(stillAsScheduled(item({}), undefined)).toMatch(/no longer exists/);
  });
});
