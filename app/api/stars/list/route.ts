import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Returns every starred opportunity id so the Stats drill-down can highlight
// matching rows on render. One small call on Stats page mount.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("starred_opportunities")
      .select("sf_opportunity_id");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const ids = (data ?? []).map(
      (r: { sf_opportunity_id: string }) => r.sf_opportunity_id,
    );
    return NextResponse.json({ ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
