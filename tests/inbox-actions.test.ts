import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-ins: nothing is sent, nothing touches Outlook or Salesforce.
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { inbox_replies: [], app_settings: [] };
let clock = 0;
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let single = false;
  const rows = () => db[name].filter((r) => filters.every((f) => f(r)));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return api; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return api; },
    order: () => api,
    limit: () => api,
    single: () => { single = true; return api; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (row: Row) => { db[name].push({ ...row, updated_at: `t${++clock}` }); return { error: null }; },
    update: (p: Row) => { patch = p; return api; },
    then: (resolve: (v: unknown) => void) => {
      if (patch) {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, patch, name === "app_settings" ? { updated_at: `t${++clock}` } : {}));
        resolve({ data: single ? hit[0] ?? null : hit.map((r) => ({ ...r })), error: single && !hit[0] ? { message: "not found" } : null });
      } else {
        const r = rows();
        resolve({ data: single ? r[0] ?? null : r, error: single && !r[0] ? { message: "not found" } : null });
      }
    },
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/anthropic", () => ({ getAnthropicClient: () => null, MODELS: { drafting: "claude-sonnet-5-5", extraction: "claude-haiku-5-5" } }));

const outlook: { readState: Record<string, boolean>; drafts: Array<{ body: string; cc: string[] }>; sent: number } = { readState: {}, drafts: [], sent: 0 };
vi.mock("@/lib/microsoft", () => ({
  getMsValidCredentials: async () => ({ access_token: "x" }),
  fetchEmailThread: async () => [],
  getMailboxIdentities: async () => new Set(["sebastian@valstonecorp.com"]),
  isSelfAddress: (e: string, ids: Set<string>) => ids.has(e.toLowerCase()),
  createOutlookReplyAllDraft: async (_id: string, body: string, opts: { extraCc: string[]; sender: { name: string; email: string } }) => {
    outlook.drafts.push({ body, cc: opts.extraCc });
    return { id: "d1", recipients: [opts.sender], cc: opts.extraCc };
  },
  sendOutlookDraft: async () => { outlook.sent++; },
  deleteOutlookDraftIfUnsent: async () => undefined,
}));
const sf: { responded: string[]; tasks: Array<{ accountId: string; from: string; days: number }> } = { responded: [], tasks: [] };
vi.mock("@/lib/inbox-salesforce", () => ({
  markAccountResponded: async (id: string, s: string) => { sf.responded.push(`${id}:${s}`); return { respondedField: "Responded__c" }; },
  scheduleRceTask: async (accountId: string, from: string, days: number) => {
    sf.tasks.push({ accountId, from, days });
    const d = new Date(`${from.slice(0, 10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
    return { taskId: "T1", date: d.toISOString().slice(0, 10), action: "moved" };
  },
}));
vi.mock("@/lib/sf-query", () => ({ sfQuery: async () => [] }));

// Graph PATCH isRead
vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
  const m = url.match(/\/me\/messages\/([^?]+)/);
  if (m && init?.method === "PATCH") outlook.readState[decodeURIComponent(m[1])] = JSON.parse(init.body!).isRead;
  return new Response("{}", { status: 200 });
});

import { dismissInboxRow, listInbox, remindAfterOutOfOffice, sendInboxReply, undismissInboxRow } from "@/lib/inbox";
import { saveInboxMeta } from "@/lib/inbox-meta";

const base = (id: string, o: Row = {}) => ({
  message_id: id, conversation_id: `c-${id}`, subject: "Re: Valstone | Ecto", from_name: "Jeff Kumik", from_email: "jeff@ecto.com", from_domain: "ecto.com",
  received_at: "2026-11-10T14:00:00Z", preview: "", thread: [{ from: "Jeff", email: "jeff@ecto.com", at: "2026-11-10T14:00:00Z", mine: false, text: "Financials attached. Call tomorrow at 4:30?" }],
  has_mine: true, account_id: "001A", account_name: "Ecto", account_matched_by: "contact", sentiment: "positive", timing_text: null, suggested_date: null,
  summary: "", is_broker_intro: false, status: "new", draft_body: null, sent_at: null, sf_responded_at: null, task_id: null, task_date: null, created_at: "", updated_at: "", ...o,
});

beforeEach(() => {
  db.inbox_replies = []; db.app_settings = [];
  outlook.readState = {}; outlook.drafts = []; outlook.sent = 0;
  sf.responded = []; sf.tasks = [];
});

describe("CC switch on send", () => {
  it("a positive reply with the switch off goes without the scheduling bot", async () => {
    db.inbox_replies.push(base("m1"));
    const r = await sendInboxReply({ messageId: "m1", body: "Hi Jeff,\n\nTomorrow at 4:30 works.\n\nBest,\nSebastian", rceDays: null, sentiment: "positive", cc: false });
    expect(outlook.drafts[0].cc).toEqual([]);
    expect(outlook.sent).toBe(1);
    expect(sf.responded).toEqual(["001A:positive"]); // Salesforce still gets Responded
    expect(sf.tasks).toEqual([]);
    expect(r.item.status).toBe("sent");
  });
  it("switch on copies it, even on an acknowledgement", async () => {
    db.inbox_replies.push(base("m1", { sentiment: "neutral" }));
    await sendInboxReply({ messageId: "m1", body: "Hi Jeff,\n\nThank you.\n\nBest,\nSebastian", rceDays: 30, sentiment: "neutral", cc: true });
    expect(outlook.drafts[0].cc).toEqual(["bot@blockit.com"]);
    expect(sf.tasks).toHaveLength(1);
  });
});

describe("dismiss and undo", () => {
  it("dismiss files it and marks it read in Outlook; undo puts it back unread", async () => {
    db.inbox_replies.push(base("m1", { draft_body: "Hi" }));
    const d = await dismissInboxRow("m1");
    expect(d.item.status).toBe("skipped");
    expect(outlook.readState.m1).toBe(true);
    expect(outlook.sent).toBe(0);
    expect(sf.responded).toEqual([]);
    const u = await undismissInboxRow("m1");
    expect(u.status).toBe("drafted");
    expect(outlook.readState.m1).toBe(false);
  });
  it("an answered reply cannot be dismissed", async () => {
    db.inbox_replies.push(base("m1", { status: "sent" }));
    await expect(dismissInboxRow("m1")).rejects.toThrow(/already answered/);
  });
});

describe("out of office", () => {
  it("reply type and return date come back on the list", async () => {
    db.inbox_replies.push(base("m1"), base("m2"));
    await saveInboxMeta({ m1: { replyType: "none", autoReply: "out_of_office", returnDate: "2026-11-18", newContact: null } });
    const items = await listInbox();
    expect(items.find((r) => r.message_id === "m1")).toMatchObject({ reply_type: "none", auto_reply: "out_of_office", return_date: "2026-11-18" });
    expect(items.find((r) => r.message_id === "m2")).toMatchObject({ reply_type: "book_call", auto_reply: null }); // no extras: sentiment default
  });
  it("RCE the day after they are back, only on the tap, then filed", async () => {
    db.inbox_replies.push(base("m1"));
    await saveInboxMeta({ m1: { replyType: "none", autoReply: "out_of_office", returnDate: "2099-01-10", newContact: null } });
    const r = await remindAfterOutOfOffice("m1");
    expect(r.task.date).toBe("2099-01-11");
    expect(r.item.status).toBe("skipped");
    expect(outlook.sent).toBe(0);
  });
  it("refuses without a return date or an account", async () => {
    db.inbox_replies.push(base("m1", { account_id: null }), base("m2"));
    await saveInboxMeta({ m1: { replyType: "none", autoReply: "out_of_office", returnDate: "2099-01-10", newContact: null }, m2: { replyType: "none", autoReply: "out_of_office", returnDate: null, newContact: null } });
    await expect(remindAfterOutOfOffice("m1")).rejects.toThrow(/account/);
    await expect(remindAfterOutOfOffice("m2")).rejects.toThrow(/return date/);
    expect(sf.tasks).toEqual([]);
  });
});
