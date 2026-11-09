import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory stand-ins: nothing here touches Salesforce or Supabase ─────────
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { app_settings: [], weekly_outreach: [], e1_sends: [] };
let clock = 0;
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" = "select";
  let patch: Row = {};
  const rows = () => db[name].filter((r) => filters.every((f) => f(r)));
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return api; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return api; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (row: Row) => { db[name].push({ ...row, updated_at: `t${++clock}` }); return { error: null }; },
    upsert: async (row: Row) => { db[name] = db[name].filter((r) => r.key !== row.key); db[name].push({ ...row, updated_at: `t${++clock}` }); return { error: null }; },
    update: (p: Row) => { mode = "update"; patch = p; return api; },
    then: (resolve: (v: unknown) => void) => {
      if (mode === "update") {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, patch, { updated_at: `t${++clock}` }));
        resolve({ data: hit.map((r) => ({ key: r.key })), error: null });
      } else resolve({ data: rows(), error: null });
    },
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: async () => undefined } }));
vi.mock("@/lib/token-manager", () => ({ getValidCredentials: async () => ({}) }));

const descriptions = new Map<string, string | null>();
const e1Tasks: Array<{ AccountId: string; CreatedDate: string }> = [];
const writes: string[] = [];
vi.mock("@/lib/sf-query", () => ({
  assertSalesforceId: (id: string) => id,
  sfErrorText: async () => "error",
  sfQuery: async (soql: string) => {
    if (soql.startsWith("SELECT Id, Description FROM Account")) {
      return [...descriptions.entries()].filter(([id]) => soql.includes(`'${id}'`)).map(([Id, Description]) => ({ Id, Description }));
    }
    const since = soql.match(/CreatedDate >= (\S+)/)![1];
    return e1Tasks.filter((t) => soql.includes(`'${t.AccountId}'`) && t.CreatedDate >= since);
  },
  sfFetch: async (path: string, init: { body: string }) => {
    const id = path.split("/").pop()!;
    descriptions.set(id, JSON.parse(init.body).Description);
    writes.push(id);
    return new Response(null, { status: 204 });
  },
}));

import { noteLine, runContactNotes, saveContactNotesSettings, withNote, withoutNote, listContactNotes } from "@/lib/contact-notes";

const monday = new Date("2026-11-09T15:00:00Z"); // Mon Nov 9, 10am Montreal
const row = (id: string, account: string, o: Row = {}) => ({
  id, sf_account_id: account, account_name: `Co ${account}`, status: "queued", created_at: "2026-11-09T14:00:00Z", week_start: "2026-11-09", outreach_type: "E1", ...o,
});

beforeEach(() => {
  db.app_settings = []; db.weekly_outreach = []; db.e1_sends = [];
  descriptions.clear(); e1Tasks.length = 0; writes.length = 0;
});

describe("the text", () => {
  it("puts the line on top above two blank lines and keeps everything else", () => {
    expect(withNote("Founded 1998. Owner: Jim.", "2026-11-09: Will contact this week")).toBe("2026-11-09: Will contact this week\n\n\nFounded 1998. Owner: Jim.");
    expect(withNote(null, "2026-11-09: Will contact this week")).toBe("2026-11-09: Will contact this week");
    // An older line of ours is replaced, never stacked.
    expect(withNote("2026-10-05: Will contact this week\n\n\nFounded 1998.", "2026-11-09: Will contact this week")).toBe("2026-11-09: Will contact this week\n\n\nFounded 1998.");
  });
  it("takes off exactly that line and the blank lines under it, nothing else", () => {
    expect(withoutNote("2026-11-09: Will contact this week\n\n\nFounded 1998.\n\nOwner: Jim.", "2026-11-09: Will contact this week")).toBe("Founded 1998.\n\nOwner: Jim.");
    expect(withoutNote("2026-11-09: Will contact this week", "2026-11-09: Will contact this week")).toBe("");
  });
  it("leaves the description alone when the line was edited or moved by hand", () => {
    expect(withoutNote("Founded 1998.\n2026-11-09: Will contact this week", "2026-11-09: Will contact this week")).toBeNull();
    expect(withoutNote("2026-11-09: Will contact this week, call Jim first", "2026-11-09: Will contact this week")).toBeNull();
  });
  it("uses the date the row went in", () => {
    expect(noteLine("2026-11-09")).toBe("2026-11-09: Will contact this week");
  });
});

describe("the run, with stand-ins", () => {
  it("marks this week's unsent E1s, including ones added before this was built, and leaves RCEs and sent ones alone", async () => {
    db.weekly_outreach.push(row("w1", "A1"), row("w2", "A2", { status: "sent" }), row("w3", "A3", { outreach_type: "RCE" }), row("w4", "A4", { week_start: "2026-11-16" }));
    descriptions.set("A1", "Founded 1998."); descriptions.set("A2", "x"); descriptions.set("A3", "y"); descriptions.set("A4", "z");
    const r = await runContactNotes(monday);
    expect(r).toMatchObject({ added: 1, removed: 0 });
    expect(descriptions.get("A1")).toBe("2026-11-09: Will contact this week\n\n\nFounded 1998.");
    expect(writes).toEqual(["A1"]);
  });

  it("running again changes nothing", async () => {
    db.weekly_outreach.push(row("w1", "A1"));
    descriptions.set("A1", "Founded 1998.");
    await runContactNotes(monday);
    writes.length = 0;
    expect(await runContactNotes(monday)).toMatchObject({ added: 0, removed: 0 });
    expect(writes).toEqual([]);
  });

  it("takes the line off once Salesforce logs the E1, and keeps what Seb added meanwhile", async () => {
    db.weekly_outreach.push(row("w1", "A1"));
    descriptions.set("A1", "Founded 1998.");
    await runContactNotes(monday);
    descriptions.set("A1", descriptions.get("A1") + "\n\nCalled Nov 9, CEO is Jim.");
    e1Tasks.push({ AccountId: "A1", CreatedDate: "2026-11-10T14:00:00Z" });
    const r = await runContactNotes(new Date("2026-11-10T16:00:00Z"));
    expect(r.removed).toBe(1);
    expect(descriptions.get("A1")).toBe("Founded 1998.\n\nCalled Nov 9, CEO is Jim.");
    expect((await listContactNotes())[0]).toMatchObject({ status: "removed", removedReason: "E1 sent." });
  });

  it("an E1 from last month does not count as this one going out", async () => {
    db.weekly_outreach.push(row("w1", "A1"));
    descriptions.set("A1", "x");
    e1Tasks.push({ AccountId: "A1", CreatedDate: "2026-10-12T14:00:00Z" });
    expect((await runContactNotes(monday)).added).toBe(1);
  });

  it("a send scheduled for later keeps the line until it actually goes", async () => {
    db.weekly_outreach.push(row("w1", "A1"));
    descriptions.set("A1", "x");
    await runContactNotes(monday);
    db.weekly_outreach[0].status = "sent"; // the app marks the row sent when the E1 is scheduled
    db.e1_sends.push({ weekly_outreach_id: "w1", status: "scheduled", scheduled_for: "2026-11-11T13:00:00Z" });
    expect((await runContactNotes(new Date("2026-11-10T16:00:00Z"))).removed).toBe(0);
    expect((await runContactNotes(new Date("2026-11-11T14:00:00Z"))).removed).toBe(1); // after the scheduled time
    expect(descriptions.get("A1")).toBe("x");
  });

  it("removing the row, or the week ending without a send, takes the line off", async () => {
    db.weekly_outreach.push(row("w1", "A1"), row("w2", "A2"));
    descriptions.set("A1", "a"); descriptions.set("A2", "b");
    await runContactNotes(monday);
    db.weekly_outreach = db.weekly_outreach.filter((r) => r.id !== "w1");
    const r1 = await runContactNotes(monday);
    expect(r1.removed).toBe(1);
    expect(descriptions.get("A1")).toBe("a");
    const r2 = await runContactNotes(new Date("2026-11-16T15:00:00Z")); // next Monday
    expect(r2.removed).toBe(1);
    expect(descriptions.get("A2")).toBe("b");
  });

  it("the pause switch stops all writes", async () => {
    db.weekly_outreach.push(row("w1", "A1"));
    descriptions.set("A1", "a");
    await saveContactNotesSettings(true);
    expect((await runContactNotes(monday)).paused).toBe(true);
    expect(writes).toEqual([]);
  });
});
