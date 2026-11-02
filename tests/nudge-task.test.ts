import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];

vi.mock("@/lib/token-manager", () => ({ getValidCredentials: async () => ({ salesforce_user_id: "005000000000001AAA" }) }));
vi.mock("@/lib/sf-query", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    sfFetch: async (path: string, init: RequestInit = {}) => {
      calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : {} });
      return new Response("{}", { status: 200 });
    },
  };
});
vi.mock("@/lib/microsoft", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getMailboxIdentities: async () => new Set(["sebastian@valstonecorp.com"]),
  createOutlookReplyAllDraft: async () => ({ id: "d1", recipients: [{ name: "Marcus", email: "marcus@example.com" }] }),
  createOutlookNewDraft: async () => ({ id: "d1" }),
  sendOutlookDraft: async () => undefined,
  deleteOutlookDraftIfUnsent: async () => undefined,
}));

import { sendNudge } from "@/lib/nudges";

const base = {
  replyToMessageId: "m1",
  sender: { name: "Marcus", email: "marcus@example.com" },
  body: "Hi Marcus,\n\nJust checking in.\n\nBest,\nSeb",
  taskId: "00T000000000001AAA",
  accountId: "001000000000001AAA",
  subject: "RCE",
};

describe("sendNudge Salesforce side", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("only moves the existing open task, never completes it or creates one", async () => {
    const out = await sendNudge({ ...base, days: 30 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].path).toContain("/sobjects/Task/00T000000000001AAA");
    expect(Object.keys(calls[0].body)).toEqual(["ActivityDate"]);
    expect(out.newTaskDate).toBe(calls[0].body.ActivityDate);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("leaves the task alone when no days are given", async () => {
    const out = await sendNudge({ ...base, days: null });
    expect(calls).toHaveLength(0);
    expect(out.newTaskDate).toBeNull();
  });
});
