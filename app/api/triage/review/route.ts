import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isAuthenticated } from "@/lib/auth";

// PATCH /api/triage/review
// Update the review status of an email (approve, edit, reject)
export async function PATCH(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { id, review_status, edited_draft } = body;

  if (!id || !review_status) {
    return NextResponse.json(
      { error: "Missing id or review_status" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();

  const updateData: Record<string, unknown> = {
    review_status,
    reviewed_at: new Date().toISOString(),
  };

  if (review_status === "edited" && edited_draft) {
    updateData.edited_draft = edited_draft;
  }

  const { error } = await supabase
    .from("email_triage")
    .update(updateData)
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
