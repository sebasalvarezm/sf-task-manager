import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { sent_replies: [], app_settings: [], model_calls: [] };
const rpcCalls: unknown[] = [];
function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => db[name].filter((r) => filters.every((f) => f(r)));
  const api: Record<string, unknown> = {
    select: (_c?: string, o?: { head?: boolean }) => { if (o?.head) return Promise.resolve({ count: db[name].length, error: null }); return api; },
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return api; },
    in: () => { throw new Error("no long id lists in a request"); },
    gte: () => api,
    range: () => api,
    limit: () => api,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (row: Row) => { db[name].push(row); return { error: null }; },
    upsert: async (rs: Row[]) => { for (const r of rs) { db[name] = db[name].filter((x) => x.message_id !== r.message_id); db[name].push(r); } return { error: null }; },
    update: (p: Row) => ({ eq: async (k: string, v: unknown) => { db[name].filter((r) => r[k] === v).forEach((r) => Object.assign(r, p)); return { error: null }; } }),
    then: (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null }),
  };
  return api;
}
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: (n: string) => table(n),
    rpc: async (_fn: string, args: unknown) => { rpcCalls.push(args); return { data: db.sent_replies.slice(0, 8).map((r) => ({ to_name: r.to_name, subject: r.subject, body: r.body })), error: null }; },
  }),
}));
vi.mock("@/lib/model-cost", () => ({ recordModelCall: async () => undefined, spentTodayUsd: async () => spent }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: async () => undefined } }));
vi.mock("@/lib/microsoft", () => ({
  getMsValidCredentials: async () => ({ access_token: "x" }),
  getMailboxIdentities: async () => new Set(["sebastian@valstonecorp.com"]),
}));
let spent = 0;

import { documentText, embed, indexSentReplies, indexStopReason, similarReplies, splitSentMessage, usableSent } from "@/lib/reply-search";

const vec = () => Array.from({ length: 512 }, () => 0.01);
const voyageCalls: Array<{ input: string[]; input_type: string }> = [];
function fakeFetch(pages: Array<{ value: Row[]; next?: string }>) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.startsWith("https://api.voyageai.com")) {
      const b = JSON.parse(init!.body!);
      voyageCalls.push(b);
      return new Response(JSON.stringify({ data: b.input.map((_: string, i: number) => ({ embedding: vec(), index: i })), usage: { total_tokens: 100 } }), { status: 200 });
    }
    const n = url.includes("page=2") ? 1 : 0;
    const p = pages[n];
    return new Response(JSON.stringify({ value: p.value, ...(p.next ? { "@odata.nextLink": p.next } : {}) }), { status: 200 });
  });
}

const reply = (id: string, o: Row = {}) => ({
  id, subject: "RE: Valstone | Ecto", sentDateTime: "2026-11-01T14:00:00Z",
  toRecipients: [{ emailAddress: { name: "Jeff Kumik", address: "jeff@ecto.com" } }],
  body: { content: "Hi Jeff,\n\nThank you for sending these over. I'll go through them this week.\n\nBest,\nSebastian\n\nFrom: Jeff Kumik <jeff@ecto.com>\nSent: Friday, October 31, 2026 9:00 AM\nTo: Sebastian Alvarez\nSubject: RE: Valstone | Ecto\n\nHi Sebastian,\n\nAttached are our financials for 2023 to 2025.\n\nJeff" },
  ...o,
});

beforeEach(() => {
  db.sent_replies = []; db.app_settings = []; voyageCalls.length = 0; rpcCalls.length = 0; spent = 0;
  process.env.VOYAGE_API_KEY = "test-key";
});
afterEach(() => vi.unstubAllGlobals());

describe("reading a sent reply", () => {
  it("splits Seb's reply from the email he answered", () => {
    const s = splitSentMessage(reply("a").body.content);
    expect(s.mine).toBe("Hi Jeff,\n\nThank you for sending these over. I'll go through them this week.\n\nBest,\nSebastian");
    expect(s.theirs).toBe("Hi Sebastian,\n\nAttached are our financials for 2023 to 2025.\n\nJeff");
    expect(documentText(s.theirs, s.mine)).toMatch(/^Their email:\nHi Sebastian/);
  });
  it("handles the Gmail-style quote", () => {
    const s = splitSentMessage("Understood, thank you.\n\nBest,\nSebastian\n\nOn Tue, Nov 3, 2026 at 9:00 AM Ann <ann@x.com> wrote:\n> Not selling right now, maybe in the spring.\n> Ann");
    expect(s.theirs).toMatch(/^Not selling right now/);
  });
  it("keeps only replies to outside people, never Valstone colleagues or the scheduling bot", () => {
    const own = new Set(["valstonecorp.com"]);
    expect(usableSent(reply("a"), own)).not.toBeNull();
    expect(usableSent(reply("b", { subject: "Valstone | Ecto" }), own)).toBeNull(); // not a reply
    expect(usableSent(reply("c", { toRecipients: [{ emailAddress: { address: "steph@valstonecorp.com" } }] }), own)).toBeNull();
    expect(usableSent(reply("d", { toRecipients: [{ emailAddress: { address: "bot@blockit.com" } }] }), own)).toBeNull();
    expect(usableSent(reply("e", { body: { content: "Ok." } }), own)).toBeNull(); // too short
  });
});

describe("Voyage calls", () => {
  it("no key: refuses before calling anything", async () => {
    delete process.env.VOYAGE_API_KEY;
    const f = fakeFetch([{ value: [] }]); vi.stubGlobal("fetch", f);
    await expect(embed(["x"], "query")).rejects.toThrow("VOYAGE_NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });
  it("over the daily cap: refuses before calling", async () => {
    spent = 0.5;
    const f = fakeFetch([{ value: [] }]); vi.stubGlobal("fetch", f);
    await expect(embed(["x"], "query")).rejects.toThrow("REPLY_SEARCH_CAP");
    expect(f).not.toHaveBeenCalled();
  });
  it("asks for 512-dimension vectors from voyage-4-lite and keeps them in order", async () => {
    vi.stubGlobal("fetch", fakeFetch([{ value: [] }]));
    const v = await embed(["a", "b"], "document");
    expect(v).toHaveLength(2);
    expect(voyageCalls[0]).toMatchObject({ model: "voyage-4-lite", input_type: "document", output_dimension: 512 });
  });
});

describe("indexing and search", () => {
  it("indexes new usable replies across pages, once", async () => {
    vi.stubGlobal("fetch", fakeFetch([
      { value: [reply("a"), reply("b", { subject: "Lunch?" })], next: "https://graph.microsoft.com/v1.0/x?page=2" },
      { value: [reply("c")] },
    ]));
    const s = await indexSentReplies(365);
    expect(s).toMatchObject({ scanned: 3, usable: 2, added: 2 });
    const again = await indexSentReplies(365);
    expect(again.added).toBe(0);
    expect(voyageCalls).toHaveLength(1); // nothing embedded twice
  });
  it("paused: reads nothing", async () => {
    db.app_settings.push({ key: "reply_search_settings", value: { paused: true } });
    const f = fakeFetch([{ value: [reply("a")] }]); vi.stubGlobal("fetch", f);
    expect((await indexSentReplies(365)).stoppedBy).toBe("paused");
    expect(f).not.toHaveBeenCalled();
    expect(await similarReplies("Attached are our financials")).toBeNull();
  });
  it("search returns stored replies; without a key it returns null so drafts fall back to recent replies", async () => {
    vi.stubGlobal("fetch", fakeFetch([{ value: [reply("a")] }]));
    await indexSentReplies(30);
    const hits = await similarReplies("Here are the financials you asked for");
    expect(hits?.[0]).toMatchObject({ to: "Jeff Kumik", subject: "RE: Valstone | Ecto" });
    expect(voyageCalls.at(-1)?.input_type).toBe("query");
    delete process.env.VOYAGE_API_KEY;
    expect(await similarReplies("Here are the financials")).toBeNull();
  });
});

describe("Voyage limits", () => {
  it("a rate limit waits once, then stops with a plain reason instead of failing silently", async () => {
    vi.useFakeTimers();
    let voyage = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("https://api.voyageai.com")) { voyage++; return new Response("rate limited", { status: 429 }); }
      return new Response(JSON.stringify({ value: [reply("a")] }), { status: 200 });
    }));
    const run = indexSentReplies(30);
    await vi.advanceTimersByTimeAsync(25_000);
    const s = await run;
    vi.useRealTimers();
    expect(voyage).toBe(2);
    expect(s).toMatchObject({ added: 0, stoppedBy: "VOYAGE_RATE_LIMIT" });
    expect(indexStopReason(s.stoppedBy)).toMatch(/payment method/);
  });
  it("a rejected key says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("https://api.voyageai.com") ? new Response("no", { status: 401 }) : new Response(JSON.stringify({ value: [reply("a")] }), { status: 200 })));
    expect(indexStopReason((await indexSentReplies(30)).stoppedBy)).toMatch(/rejected the key/);
  });
});
