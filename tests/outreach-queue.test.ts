import { describe, it, expect } from "vitest";
import {
  classify,
  groupSequences,
  cleanE1Subject,
  cleanE1Body,
} from "../lib/outreach-queue";
import type { SfAccountWithETasks, SfETask } from "../lib/salesforce-contacts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let idCounter = 0;

/** ISO datetime `days` days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** YYYY-MM-DD `days` days before now (Salesforce LastActivityDate shape). */
function dayOnly(days: number): string {
  return daysAgo(days).slice(0, 10);
}

function task(
  subjectType: string,
  whoId: string,
  opts: {
    completedAt?: string | null;
    activityDate?: string | null;
    status?: string;
  } = {},
): SfETask {
  return {
    Id: `t${++idCounter}`,
    Subject: `[${subjectType}] - Test subject`,
    Description: null,
    SubjectType: subjectType,
    ActivityDate: opts.activityDate ?? null,
    CompletedDateTime:
      opts.completedAt === undefined ? daysAgo(90) : opts.completedAt,
    WhoId: whoId,
    WhoName: "Test Person",
    WhoEmail: "test@example.com",
    Status: opts.status ?? "Completed",
    Type: null,
  };
}

/** A full E1–E5 sequence for one contact, each step completed `endDays` ago
 * (E5) back through `endDays + 20` (E1). */
function fullSequence(whoId: string, endDays: number): SfETask[] {
  return ["E1", "E2", "E3", "E4", "E5"].map((st, i) =>
    task(st, whoId, { completedAt: daysAgo(endDays + (4 - i) * 5) }),
  );
}

function account(
  tasks: SfETask[],
  overrides: Partial<SfAccountWithETasks> = {},
): SfAccountWithETasks {
  return {
    Id: "001xx0000000001",
    Name: "Acme Test Co",
    Website: "https://acmetest.com",
    Responded__c: null,
    LastActivityDate: null,
    Employees: 40,
    Tasks: tasks,
    ...overrides,
  };
}

// ── classify ─────────────────────────────────────────────────────────────────

describe("classify — the queue bucket rules", () => {
  it("one complete E1–E5 sequence, quiet since → DUE_2ND_HIT", () => {
    const tasks = fullSequence("who1", 90);
    const acc = account(tasks);
    expect(classify(acc, groupSequences(tasks))).toBe("DUE_2ND_HIT");
  });

  it("any E1–E4 completed in the last 30 days → NOT_DUE (sequence in flight)", () => {
    const tasks = [
      ...fullSequence("who1", 90),
      task("E2", "who2", { completedAt: daysAgo(10) }),
    ];
    const acc = account(tasks);
    expect(classify(acc, groupSequences(tasks))).toBe("NOT_DUE");
  });

  it("account activity AFTER the E5 end day → NOT_DUE (someone replied or followed up)", () => {
    const tasks = fullSequence("who1", 90);
    const acc = account(tasks, { LastActivityDate: dayOnly(85) });
    expect(classify(acc, groupSequences(tasks))).toBe("NOT_DUE");
  });

  it("account activity on the SAME day as the E5 → still DUE_2ND_HIT (the E5 itself counts as activity)", () => {
    const tasks = fullSequence("who1", 90);
    const acc = account(tasks, { LastActivityDate: dayOnly(90) });
    expect(classify(acc, groupSequences(tasks))).toBe("DUE_2ND_HIT");
  });

  it("two complete sequences, last ended 60+ days ago → DUE_RESTART", () => {
    const tasks = [...fullSequence("who1", 200), ...fullSequence("who2", 90)];
    const acc = account(tasks);
    expect(classify(acc, groupSequences(tasks))).toBe("DUE_RESTART");
  });

  it("two complete sequences, last ended under 60 days ago → NOT_DUE (cooldown)", () => {
    const tasks = [...fullSequence("who1", 200), ...fullSequence("who2", 45)];
    const acc = account(tasks);
    expect(classify(acc, groupSequences(tasks))).toBe("NOT_DUE");
  });

  it("a partial sequence started AFTER the last complete one → NOT_DUE (next hit already in progress)", () => {
    const tasks = [
      ...fullSequence("who1", 120),
      // E1 only, started after the complete sequence ended (but outside the
      // 30-day in-flight window, so only the newer-partial rule can catch it)
      task("E1", "who2", { completedAt: daysAgo(60) }),
    ];
    const acc = account(tasks);
    expect(classify(acc, groupSequences(tasks))).toBe("NOT_DUE");
  });

  it("a stale partial that predates the complete sequence does not block → DUE_2ND_HIT", () => {
    const tasks = [
      task("E1", "who0", { completedAt: daysAgo(300) }), // abandoned attempt
      ...fullSequence("who1", 90),
    ];
    const acc = account(tasks);
    expect(classify(acc, groupSequences(tasks))).toBe("DUE_2ND_HIT");
  });

  it("no complete sequence at all → NOT_DUE", () => {
    const tasks = [
      task("E1", "who1", { completedAt: daysAgo(90) }),
      task("E2", "who1", { completedAt: daysAgo(85) }),
    ];
    const acc = account(tasks);
    expect(classify(acc, groupSequences(tasks))).toBe("NOT_DUE");
  });
});

// ── groupSequences ───────────────────────────────────────────────────────────

describe("groupSequences — how sequences and their ended date are derived", () => {
  it("a contact with all five E-types completed counts as complete", () => {
    const [h] = groupSequences(fullSequence("who1", 90));
    expect(h.status).toBe("complete");
    expect(h.stepsCompleted).toBe(5);
  });

  it("ended date = CompletedDateTime of the most recent completed E5", () => {
    const end = daysAgo(90);
    const tasks = fullSequence("who1", 90);
    tasks[4].CompletedDateTime = end;
    const [h] = groupSequences(tasks);
    expect(h.endedAt).toBe(end);
  });

  it("ended date falls back to ActivityDate when the E5 has no CompletedDateTime (InMails, manual completes)", () => {
    const tasks = fullSequence("who1", 90);
    tasks[4].CompletedDateTime = null;
    tasks[4].ActivityDate = dayOnly(88);
    const [h] = groupSequences(tasks);
    expect(h.endedAt).toBe(dayOnly(88));
  });

  it("a sequence split across two contacts is two partials, never one complete", () => {
    const tasks = [
      task("E1", "whoA", { completedAt: daysAgo(100) }),
      task("E2", "whoA", { completedAt: daysAgo(95) }),
      task("E3", "whoB", { completedAt: daysAgo(90) }),
      task("E4", "whoB", { completedAt: daysAgo(85) }),
      task("E5", "whoB", { completedAt: daysAgo(80) }),
    ];
    const histories = groupSequences(tasks);
    expect(histories).toHaveLength(2);
    expect(histories.every((h) => h.status === "partial")).toBe(true);
  });

  it("non-completed tasks do not count toward steps", () => {
    const tasks = fullSequence("who1", 90);
    tasks[4].Status = "Open";
    const [h] = groupSequences(tasks);
    expect(h.stepsCompleted).toBe(4);
    expect(h.status).toBe("partial");
  });
});

// ── E1 content cleanup ───────────────────────────────────────────────────────

describe("cleanE1Subject / cleanE1Body", () => {
  it("strips the [E1] prefix from subjects", () => {
    expect(cleanE1Subject("[E1] - Quick intro")).toBe("Quick intro");
    expect(cleanE1Subject("[E3] – Following up")).toBe("Following up");
  });

  it("cuts header noise before the salutation and the signature after Best", () => {
    const raw =
      "From: Nate Sabb <nate@example.com>\nTo: someone@corp.com\n\nHi John,\n\nGreat to connect.\n\nBest,\nNate\n\nCONFIDENTIALITY NOTICE: this email...";
    const cleaned = cleanE1Body(raw)!;
    expect(cleaned.startsWith("Hi John,")).toBe(true);
    expect(cleaned).not.toContain("CONFIDENTIALITY");
    expect(cleaned).not.toContain("From:");
  });

  it("replaces the original team member's sign-off with the active user", () => {
    const cleaned = cleanE1Body("Hi John,\n\nMy name is Nate.\n\nBest,\nNate")!;
    expect(cleaned).toContain("My name is Sebastian");
    expect(cleaned.endsWith("Sebastian")).toBe(true);
    expect(cleaned).not.toContain("Nate");
  });
});
