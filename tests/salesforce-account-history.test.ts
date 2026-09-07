import { beforeEach, describe, expect, it, vi } from "vitest";

const sfQueryMock = vi.fn();
vi.mock("../lib/sf-query", () => ({ sfQuery: (soql: string) => sfQueryMock(soql) }));
vi.mock("../lib/token-manager", () => ({
  getValidCredentials: async () => ({
    instance_url: "https://example.my.salesforce.com",
    access_token: "token",
    salesforce_user_id: "005SEB",
  }),
}));

import { fetchAccountHistory } from "../lib/salesforce-account-history";

/** Shape of the WorkforceQA timeline: Mark Robin emailed David Lord in Feb 2026, Seb never did. */
const markTasks = [
  {
    Id: "1", Subject: "[Outreach] [Email] [Out] Re: Intro: Mark <> David", Description: "Hi David, following up...",
    ActivityDate: "2026-02-24", CreatedDate: "2026-02-24T10:00:00Z", Status: "Completed", TaskSubtype: "Email",
    OwnerId: "005MARK", Owner: { Name: "Mark Robin" }, Who: { Name: "David Lord", Email: "david@workforceqa.com" },
  },
  {
    Id: "2", Subject: "[Outreach] [Email] [In] Re: Intro: Mark <> David", Description: "Thanks Mark, let's talk in Q2.",
    ActivityDate: "2026-02-19", CreatedDate: "2026-02-19T10:00:00Z", Status: "Completed", TaskSubtype: "Email",
    OwnerId: "005MARK", Owner: { Name: "Mark Robin" }, Who: { Name: "David Lord", Email: "david@workforceqa.com" },
  },
  {
    Id: "3", Subject: "[E1] - Intro: Mark <> David", Description: null,
    ActivityDate: "2026-02-09", CreatedDate: "2026-02-09T10:00:00Z", Status: "Completed", TaskSubtype: "Email",
    OwnerId: "005MARK", Owner: { Name: "Mark Robin" }, Who: { Name: "David Lord", Email: "david@workforceqa.com" },
  },
];

function routeQueries(handlers: { tasks?: unknown[]; emails?: unknown[]; user?: string | null }) {
  sfQueryMock.mockImplementation(async (soql: string) => {
    if (soql.includes("FROM Task")) return handlers.tasks ?? [];
    if (soql.includes("FROM EmailMessage")) return handlers.emails ?? [];
    if (soql.includes("FROM User")) return handlers.user === null ? [] : [{ Name: handlers.user ?? "Sebastian Alvarez" }];
    return [];
  });
}

describe("fetchAccountHistory", () => {
  beforeEach(() => {
    sfQueryMock.mockReset();
  });

  it("flags a takeover when only a colleague has exchanged with the target", async () => {
    routeQueries({ tasks: markTasks });
    const history = await fetchAccountHistory("001WQA");
    expect(history.takeover).not.toBeNull();
    expect(history.takeover?.colleagueName).toBe("Mark Robin");
    expect(history.takeover?.contactName).toBe("David Lord");
    expect(history.takeover?.contactEmail).toBe("david@workforceqa.com");
    expect(history.takeover?.contactFirstName).toBe("David");
    expect(history.takeover?.lastExchangeDate).toBe("2026-02-24");
    expect(history.takeover?.exchangeCount).toBe(3);
  });

  it("labels colleague and me in the prompt lines, newest first", async () => {
    routeQueries({ tasks: markTasks });
    const history = await fetchAccountHistory("001WQA");
    expect(history.lines[0]).toContain("2026-02-24");
    expect(history.lines[0]).toContain("Mark Robin (colleague) -> David Lord <david@workforceqa.com>");
    expect(history.lines[1]).toContain("David Lord <david@workforceqa.com> -> Mark Robin (colleague)");
    expect(history.lines[0]).toContain("Hi David, following up...");
  });

  it("is not a takeover once the user has an email of their own on the account", async () => {
    routeQueries({
      tasks: [
        {
          Id: "9", Subject: "[Outreach] [Email] [Out] Checking in", Description: "",
          ActivityDate: "2026-06-01", CreatedDate: "2026-06-01T10:00:00Z", Status: "Completed", TaskSubtype: "Email",
          OwnerId: "005SEB", Owner: { Name: "Sebastian Alvarez" }, Who: { Name: "David Lord", Email: "david@workforceqa.com" },
        },
        ...markTasks,
      ],
    });
    const history = await fetchAccountHistory("001WQA");
    expect(history.takeover).toBeNull();
    expect(history.lines[0]).toContain("Sebastian Alvarez (me)");
  });

  it("ignores non-email tasks like RCE reminders when deciding takeover", async () => {
    routeQueries({
      tasks: [
        {
          Id: "7", Subject: "RCE", Description: null, ActivityDate: "2026-09-01", CreatedDate: "2026-09-01T10:00:00Z",
          Status: "Open", TaskSubtype: "Task", OwnerId: "005SEB", Owner: { Name: "Sebastian Alvarez" }, Who: null,
        },
      ],
    });
    const history = await fetchAccountHistory("001WQA");
    expect(history.takeover).toBeNull();
    expect(history.entries[0].isEmail).toBe(false);
  });

  it("reads EmailMessage records and works out direction from the Valstone domain", async () => {
    routeQueries({
      emails: [
        {
          Id: "e1", Subject: "Re: Intro", TextBody: "Sounds good.", MessageDate: "2026-03-03T09:00:00Z",
          FromAddress: "david@workforceqa.com", FromName: "David Lord", ToAddress: "mark@valstonecorp.com",
          Incoming: true, CreatedById: "005MARK", CreatedBy: { Name: "Mark Robin" },
        },
        {
          Id: "e2", Subject: "Intro", TextBody: "Hi David", MessageDate: "2026-03-01T09:00:00Z",
          FromAddress: "mark@valstonecorp.com", FromName: "Mark Robin", ToAddress: "david@workforceqa.com",
          Incoming: false, CreatedById: "005MARK", CreatedBy: { Name: "Mark Robin" },
        },
      ],
    });
    const history = await fetchAccountHistory("001WQA", { valstoneDomain: "valstonecorp.com" });
    expect(history.entries[0].direction).toBe("in");
    expect(history.entries[0].contactName).toBe("David Lord");
    expect(history.entries[1].direction).toBe("out");
    expect(history.entries[1].contactEmail).toBe("david@workforceqa.com");
    expect(history.takeover?.colleagueName).toBe("Mark Robin");
    expect(history.takeover?.contactEmail).toBe("david@workforceqa.com");
  });

  it("returns an empty history when Salesforce has nothing on the account", async () => {
    routeQueries({});
    const history = await fetchAccountHistory("001NEW");
    expect(history.entries).toEqual([]);
    expect(history.lines).toEqual([]);
    expect(history.takeover).toBeNull();
  });
});
