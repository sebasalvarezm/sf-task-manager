import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TaskTable from "@/app/components/TaskTable";
import type { ScheduledItem } from "@/lib/scheduled-actions-core";

const task = (id: string, name: string) => ({
  Id: id, Subject: "RCE", ActivityDate: "2026-11-11", Status: "Open", AccountId: `A${id}`, AccountName: name,
  AccountUrl: null, AccountWebsite: null, AccountFounded: null, AccountEmployees: null,
}) as never;

describe("Open Tasks table with a task waiting for Monday", () => {
  it("shows the waiting task locked with its Monday and Cancel, and the other one editable", () => {
    const waiting = new Map<string, ScheduledItem>([["T1", {
      id: "s1", taskId: "T1", accountId: "AT1", accountName: "Acme", subject: "RCE", currentDate: "2026-11-11", days: 7,
      runOn: "2026-11-09", status: "scheduled", createdAt: "2026-11-05T19:00:00Z",
    }]]);
    const html = renderToStaticMarkup(createElement(TaskTable, {
      tasks: [task("T1", "Acme"), task("T2", "Beta")],
      actions: new Map(),
      onActionChange: () => undefined,
      waiting,
      onCancelWaiting: () => undefined,
    }));
    expect(html).toContain("RCE7 · recorded Mon, Nov 9, 7am");
    expect(html).toContain(">Cancel<");
    // Two tables (desktop and phone): the waiting task has no code box in either; the other task has one in each.
    expect((html.match(/placeholder="D \/ RCE14 \/ P30"/g) ?? []).length).toBe(1);
    expect((html.match(/placeholder="Or type: D \/ RCE14 \/ P30"/g) ?? []).length).toBe(1);
  });
});
