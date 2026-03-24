import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isAuthenticated } from "@/lib/auth";

// GET /api/triage/status
// Returns today's triage summary for the homepage tile
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().split("T")[0];
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("email_triage")
    .select("priority, review_status, is_flagged, draft")
    .eq("triage_date", today);

  if (error || !data || data.length === 0) {
    return NextResponse.json({
      available: false,
      date: today,
    });
  }

  const p1 = data.filter((e) => e.priority === "p1").length;
  const p2 = data.filter((e) => e.priority === "p2").length;
  const p3 = data.filter((e) => e.priority === "p3").length;
  const drafts = data.filter((e) => e.draft).length;
  const reviewed = data.filter(
    (e) => e.review_status && e.review_status !== "pending"
  ).length;
  const flagged = data.filter((e) => e.is_flagged).length;

  return NextResponse.json({
    available: true,
    date: today,
    total: data.length,
    p1,
    p2,
    p3,
    drafts,
    reviewed,
    flagged,
    allReviewed: drafts > 0 && reviewed >= drafts,
  });
}
