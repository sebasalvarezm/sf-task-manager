import type Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "./supabase";

/**
 * Spend log. Every tracked model call writes one row to model_calls with the
 * feature that made it, the tokens, the web searches and the dollar estimate,
 * so Stats can say "this week: Sourcing $31, Screen $9" instead of us
 * reconstructing it from the Anthropic console after the fact.
 *
 * Prices are list prices per million tokens; update when Anthropic changes
 * them. Web search is billed per search on top of tokens.
 */
const PRICES: Array<{ match: RegExp; input: number; output: number; cacheRead: number; cacheWrite: number }> = [
  { match: /opus/i, input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: /sonnet/i, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku/i, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];
const SEARCH_PRICE = 0.01;

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
};

export function estimateCost(model: string, usage: Usage): number {
  const price = PRICES.find((p) => p.match.test(model)) ?? PRICES[1];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1_000_000 +
    searches * SEARCH_PRICE
  );
}

/** Record a finished call. Never throws: a logging failure must not fail the feature. */
export async function recordModelCall(feature: string, model: string, usage: Usage | null | undefined): Promise<void> {
  if (!usage) return;
  try {
    await getSupabaseAdmin().from("model_calls").insert({
      feature,
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
      cache_write: usage.cache_creation_input_tokens ?? 0,
      searches: usage.server_tool_use?.web_search_requests ?? 0,
      cost_usd: Number(estimateCost(model, usage).toFixed(5)),
    });
  } catch {
    /* best effort */
  }
}

/**
 * client.messages.create with the spend logged under `feature`. Same arguments
 * and the same return value as the SDK call, so existing call sites can switch
 * by changing one line.
 */
export async function trackedCreate(
  client: Anthropic,
  feature: string,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  let message = await client.messages.create(params);
  void recordModelCall(feature, params.model, message.usage as unknown as Usage);
  // A reply that hit the token ceiling stops mid-sentence (or mid-JSON). That
  // happened to roughly one Inbox draft in eight: the model sometimes uses
  // part of a tight budget before writing. Retry once with three times the
  // room rather than hand Seb half an email.
  if (message.stop_reason === "max_tokens" && params.max_tokens < 4000) {
    message = await client.messages.create({ ...params, max_tokens: Math.min(4000, params.max_tokens * 3) });
    void recordModelCall(feature, params.model, message.usage as unknown as Usage);
  }
  return message;
}

/** Dollars spent since midnight UTC by the given features, from the app's own log. */
export async function spentTodayUsd(features: string[]): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await getSupabaseAdmin()
    .from("model_calls")
    .select("cost_usd")
    .in("feature", features)
    .gte("created_at", start.toISOString())
    .limit(20000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ cost_usd: number }>).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
}

export type SpendRow = { feature: string; calls: number; searches: number; cost: number };

/** Spend by feature since `since`, highest first. */
export async function spendByFeature(since: Date): Promise<{ rows: SpendRow[]; total: number }> {
  const { data, error } = await getSupabaseAdmin()
    .from("model_calls")
    .select("feature, searches, cost_usd")
    .gte("created_at", since.toISOString())
    .limit(20000);
  if (error) throw new Error(error.message);
  const map = new Map<string, SpendRow>();
  for (const r of (data ?? []) as Array<{ feature: string; searches: number; cost_usd: number }>) {
    const row = map.get(r.feature) ?? { feature: r.feature, calls: 0, searches: 0, cost: 0 };
    row.calls += 1;
    row.searches += r.searches ?? 0;
    row.cost += Number(r.cost_usd ?? 0);
    map.set(r.feature, row);
  }
  const rows = Array.from(map.values()).sort((a, b) => b.cost - a.cost);
  return { rows, total: rows.reduce((s, r) => s + r.cost, 0) };
}
