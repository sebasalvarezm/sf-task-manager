import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Toggle a star on / off for a specific opportunity. Idempotent on both sides
// (insert ignores conflict; delete is a no-op if nothing exists).
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const opportunityId =
    typeof body?.opportunityId === "string" ? body.opportunityId.trim() : "";
  const starred = body?.starred === true;

  if (!opportunityId) {
    return NextResponse.json(
      { error: "Missing opportunityId" },
      { status: 400 },
    );
  }
  // Salesforce ids are alphanumeric only — reject anything else.
  if (!/^[A-Za-z0-9]+$/.test(opportunityId)) {
    return NextResponse.json(
      { error: "Invalid opportunityId" },
      { status: 400 },
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    if (starred) {
      const { error } = await supabase
        .from("starred_opportunities")
        .upsert(
          { sf_opportunity_id: opportunityId },
          { onConflict: "sf_opportunity_id" },
        );
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    } else {
      const { error } = await supabase
        .from("starred_opportunities")
        .delete()
        .eq("sf_opportunity_id", opportunityId);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
