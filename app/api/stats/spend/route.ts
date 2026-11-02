import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { spendByFeature, type SpendRow } from "@/lib/model-cost";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** AI spend by feature: this week (7 days) and this month (30 days). */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [week, month] = await Promise.all([
      withVendorSpend(await spendByFeature(new Date(Date.now() - 7 * 86_400_000)), new Date(Date.now() - 7 * 86_400_000)),
      withVendorSpend(await spendByFeature(new Date(Date.now() - 30 * 86_400_000)), new Date(Date.now() - 30 * 86_400_000)),
    ]);
    return NextResponse.json({ week, month });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    if (/model_calls/.test(message) && /does not exist|relation|schema cache/.test(message)) {
      return NextResponse.json({ week: { rows: [], total: 0 }, month: { rows: [], total: 0 }, missing: true });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Discovery's Parallel and PDL calls (vendor_calls), as rows beside the model spend. Missing table: unchanged. */
async function withVendorSpend(base: { rows: SpendRow[]; total: number }, since: Date): Promise<{ rows: SpendRow[]; total: number }> {
  const { data, error } = await getSupabaseAdmin().from("vendor_calls").select("vendor, cost_usd, credits").eq("mock", false).gte("created_at", since.toISOString()).limit(10000);
  if (error || !data?.length) return base;
  const parallel: SpendRow = { feature: "discovery_parallel", calls: 0, searches: 0, cost: 0 };
  const pdl: SpendRow = { feature: "discovery_pdl", calls: 0, searches: 0, cost: 0 };
  for (const r of data as Array<{ vendor: string; cost_usd: number; credits: number }>) {
    const row = r.vendor === "parallel" ? parallel : pdl;
    row.calls += r.vendor === "pdl" ? Number(r.credits ?? 0) : 1;
    row.cost += Number(r.cost_usd ?? 0);
  }
  const rows = [...base.rows, ...[parallel, pdl].filter((r) => r.calls > 0)].sort((a, b) => b.cost - a.cost);
  return { rows, total: rows.reduce((s, r) => s + r.cost, 0) };
}
