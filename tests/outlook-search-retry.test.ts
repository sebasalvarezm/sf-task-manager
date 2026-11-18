import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "default", access_token: "t", refresh_token: "r", token_issued_at: new Date().toISOString(), updated_at: "" }, error: null }) }) }) }),
  }),
}));

import { searchMailboxMessages } from "@/lib/microsoft";

afterEach(() => vi.unstubAllGlobals());

describe("Outlook search", () => {
  it("waits and retries when Outlook says too many requests, and leaves drafts out", async () => {
    const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push(Date.now());
      if (calls.length === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "1" } });
      return new Response(JSON.stringify({ value: [
        { id: "m1", subject: "RE: Valstone Update", from: { emailAddress: { address: "Lynden.Jones@touchstar.co.uk", name: "Lynden Jones" } }, toRecipients: [], sentDateTime: "2026-06-03T08:34:56Z", body: { content: "Hi Seb" }, conversationId: "c1" },
        { id: "d1", subject: "Valstone / TouchStar Technologies catch up", isDraft: true, from: { emailAddress: { address: "seb@valstone.test" } }, toRecipients: [], sentDateTime: "2026-11-16T20:46:56Z", body: { content: "" }, conversationId: "c2" },
      ] }), { status: 200 });
    }));
    const out = await searchMailboxMessages("touchstar.co.uk", 50);
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(900);
    expect(out.map((m) => m.id)).toEqual(["m1"]);
  });

  it("still fails loudly after repeated refusals, instead of returning nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429, headers: { "Retry-After": "0" } })));
    await expect(searchMailboxMessages("touchstar.co.uk", 50)).rejects.toThrow(/Failed to search Outlook/);
  }, 20_000);
});
