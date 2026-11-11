import { describe, expect, it, vi } from "vitest";

const inserted: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: () => ({ from: () => ({ insert: async (r: Record<string, unknown>) => { inserted.push(r); return { error: null }; } }) }) }));

import { asFeature, estimateCost, recordModelCall, rowCost } from "@/lib/model-cost";

describe("prices (platform.claude.com, Nov 2026)", () => {
  it("Sonnet 5.5 is $2 in / $10 out per million", () => {
    expect(estimateCost("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(12);
  });
  it("Haiku 5.5 is $0.10 / $0.50 under 100K tokens and 5x over", () => {
    expect(estimateCost("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 1_000 })).toBeCloseTo(0.0055);
    expect(estimateCost("claude-haiku-5-5", { input_tokens: 120_000, output_tokens: 1_000 })).toBeCloseTo(0.0625);
  });
  it("web search is a cent each", () => {
    expect(estimateCost("claude-sonnet-5-5", { server_tool_use: { web_search_requests: 7 } })).toBeCloseTo(0.07);
  });
  it("Stats recomputes old rows from tokens, not the stored estimate", () => {
    expect(rowCost({ model: "claude-haiku-5-5", input_tokens: 10_000, output_tokens: 1_000, cache_read: 0, cache_write: 0, searches: 0, cost_usd: 0.015 })).toBeCloseTo(0.0015);
    expect(rowCost({ model: null, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, searches: 0, cost_usd: 0.2 })).toBe(0.2);
  });
});

describe("labels", () => {
  it("Deep hook research is logged as its own line, not Sourcing", async () => {
    inserted.length = 0;
    await asFeature("hook_research", () => recordModelCall("sourcing", "claude-sonnet-5-5", { input_tokens: 10 }));
    await recordModelCall("sourcing", "claude-sonnet-5-5", { input_tokens: 10 });
    expect(inserted.map((r) => r.feature)).toEqual(["hook_research", "sourcing"]);
  });
});
