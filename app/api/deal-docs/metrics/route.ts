import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  metricsToColumns,
  rowToDealDoc,
  type DealDocRow,
  type DealMetrics,
} from "@/lib/deal-docs";

export const dynamic = "force-dynamic";

// Saves the 7 metric fields after a manual edit. Updates only those columns
// (plus extraction_status → 'done') on the existing row for this account.
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const accountId =
    typeof body?.accountId === "string" ? body.accountId.trim() : "";
  const m = body?.metrics;

  if (!accountId || !m || typeof m !== "object") {
    return NextResponse.json(
      { error: "Missing accountId or metrics" },
      { status: 400 },
    );
  }

  const norm = (v: unknown): string | null => {
    if (v == null) return null;
    const str = String(v).trim();
    return str ? str : null;
  };
  const metrics: DealMetrics = {
    hq: norm(m.hq),
    revUsd: norm(m.revUsd),
    arrUsd: norm(m.arrUsd),
    ebitda: norm(m.ebitda),
    numCustomers: norm(m.numCustomers),
    growthRate: norm(m.growthRate),
    churn: norm(m.churn),
  };

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("deal_docs")
      .update({ ...metricsToColumns(metrics), extraction_status: "done" })
      .eq("sf_account_id", accountId)
      .select()
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "No document for this account" },
        { status: 404 },
      );
    }

    return NextResponse.json({ doc: rowToDealDoc(data as DealDocRow) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
