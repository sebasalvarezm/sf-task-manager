import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { rowToDealDoc, type DealDoc, type DealDocRow } from "@/lib/deal-docs";

export const dynamic = "force-dynamic";

// Batched lookup: ?accountIds=a,b,c → { docs: Record<accountId, DealDoc> }.
// One call covers every row in a drill-down table.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = req.nextUrl.searchParams.get("accountIds") ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ docs: {} });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("deal_docs")
      .select()
      .in("sf_account_id", ids);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const docs: Record<string, DealDoc> = {};
    for (const row of (data ?? []) as DealDocRow[]) {
      docs[row.sf_account_id] = rowToDealDoc(row);
    }

    return NextResponse.json({ docs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
