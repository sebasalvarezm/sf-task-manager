import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { spendByFeature } from "@/lib/model-cost";

export const dynamic = "force-dynamic";

/** AI spend by feature: this week (7 days) and this month (30 days). */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [week, month] = await Promise.all([
      spendByFeature(new Date(Date.now() - 7 * 86_400_000)),
      spendByFeature(new Date(Date.now() - 30 * 86_400_000)),
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
