import { describe, expect, it } from "vitest";
import { keepAfterFailure } from "@/lib/task-apply";

const a = (taskId: string, currentDate = "2026-11-02") => ({ taskId, currentDate, actionType: "delay" });

describe("keepAfterFailure", () => {
  it("keeps everything when signed out (nothing reached Salesforce)", () => {
    expect(keepAfterFailure([a("1"), a("2")], [], true)).toHaveLength(2);
  });
  it("keeps everything when the task list could not be reloaded", () => {
    expect(keepAfterFailure([a("1"), a("2")], null, false)).toHaveLength(2);
  });
  it("drops actions that already ran (task gone or moved)", () => {
    const fresh = [
      { Id: "1", ActivityDate: "2026-11-02" }, // untouched: keep
      { Id: "2", ActivityDate: "2027-03-02" }, // delayed already: drop
    ]; // 3 completed: gone from the open list, drop
    expect(keepAfterFailure([a("1"), a("2"), a("3")], fresh, false).map((x) => x.taskId)).toEqual(["1"]);
  });
});
