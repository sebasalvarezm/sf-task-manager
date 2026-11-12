import type Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "./supabase";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Spend log. Every tracked model call writes one row to model_calls with the
 * feature that made it, the tokens, the web searches and the dollar estimate,
 * so Stats can say "this week: Sourcing $31, Screen $9" instead of us
 * reconstructing it from the Anthropic console after the fact.
 *
 * Prices are Anthropic's list prices per million tokens (platform.claude.com
 * pricing page, checked Nov 11, 2026). Stats recomputes every row from its
 * tokens with this table, so a price fix also corrects past weeks. Web search
 * is billed per search on top of tokens.
 */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
const PRICES: Array<{ match: RegExp; price: Price; over100k?: Price }> = [
  // Voyage embeddings (reply search): input only. voyage-4 models also come with free tokens, so this is an upper bound.
  { match: /voyage/i, price: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { match: /opus-5/i, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { match: /sonnet-5/i, price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  // Haiku 5.5 is the one tiered model: a prompt over 100,000 tokens (cache reads and writes included) pays 5x.
  {
    match: /haiku-5/i,
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    over100k: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  // Older model families, in case an env override points at one.
  { match: /opus/i, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /sonnet/i, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /haiku/i, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
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
  const row = PRICES.find((p) => p.match.test(model)) ?? PRICES[1];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  const price = row.over100k && input + cacheRead + cacheWrite > 100_000 ? row.over100k : row.price;
  return (
    (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1_000_000 +
    searches * SEARCH_PRICE
  );
}

/**
 * Log every model call made inside `fn` under `feature`, whatever label the
 * code underneath uses. Sourcing's research helpers always say "sourcing";
 * "Deep research this hook" in the Send queue reuses them, and its cost
 * should not look like a Sourcing run (Nov 2026: $4 of "Sourcing" on a day
 * with no Sourcing).
 */
const featureOverride = new AsyncLocalStorage<string>();
export function asFeature<T>(feature: string, fn: () => Promise<T>): Promise<T> {
  return featureOverride.run(feature, fn);
}

/** Record a finished call. Never throws: a logging failure must not fail the feature. */
export async function recordModelCall(feature: string, model: string, usage: Usage | null | undefined): Promise<void> {
  if (!usage) return;
  feature = featureOverride.getStore() ?? feature;
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

const COST_COLUMNS = "model, input_tokens, output_tokens, cache_read, cache_write, searches, cost_usd";
type CostRow = { model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read: number | null; cache_write: number | null; searches: number | null; cost_usd: number | null };

/** A logged call's cost from its tokens at today's prices; the stored estimate only when the model is unknown. */
export function rowCost(r: CostRow): number {
  if (!r.model) return Number(r.cost_usd ?? 0);
  return estimateCost(r.model, {
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    cache_read_input_tokens: r.cache_read ?? 0,
    cache_creation_input_tokens: r.cache_write ?? 0,
    server_tool_use: { web_search_requests: r.searches ?? 0 },
  });
}

/** Dollars spent since midnight UTC by the given features, from the app's own log. */
export async function spentTodayUsd(features: string[]): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await getSupabaseAdmin()
    .from("model_calls")
    .select(COST_COLUMNS)
    .in("feature", features)
    .gte("created_at", start.toISOString())
    .limit(20000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as CostRow[]).reduce((s, r) => s + rowCost(r), 0);
}

export type SpendRow = { feature: string; calls: number; searches: number; cost: number };

/** Spend by feature since `since`, highest first. */
export async function spendByFeature(since: Date): Promise<{ rows: SpendRow[]; total: number }> {
  const { data, error } = await getSupabaseAdmin()
    .from("model_calls")
    .select(`feature, ${COST_COLUMNS}`)
    .gte("created_at", since.toISOString())
    .limit(20000);
  if (error) throw new Error(error.message);
  const map = new Map<string, SpendRow>();
  for (const r of (data ?? []) as unknown as Array<CostRow & { feature: string }>) {
    const row = map.get(r.feature) ?? { feature: r.feature, calls: 0, searches: 0, cost: 0 };
    row.calls += 1;
    row.searches += r.searches ?? 0;
    row.cost += rowCost(r);
    map.set(r.feature, row);
  }
  const rows = Array.from(map.values()).sort((a, b) => b.cost - a.cost);
  return { rows, total: rows.reduce((s, r) => s + r.cost, 0) };
}
