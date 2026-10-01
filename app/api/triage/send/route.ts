import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { sendEmail } from "@/lib/microsoft";

// POST /api/triage/send
// Send an approved/edited draft reply via Microsoft Graph (Outlook)
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "Missing email id" }, { status: 400 });
  }

  // Fetch the triage record to get the draft and recipient
  const supabase = getSupabaseAdmin();
  const { data: email, error: fetchError } = await supabase
    .from("email_triage")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !email) {
    return NextResponse.json(
      { error: "Email not found" },
      { status: 404 }
    );
  }

  // Use the edited draft if available, otherwise the original draft
  const draftText = email.edited_draft || email.draft;
  if (!draftText) {
    return NextResponse.json(
      { error: "No draft to send" },
      { status: 400 }
    );
  }

  if (!email.sender_email) {
    return NextResponse.json(
      { error: "No recipient email address available" },
      { status: 400 }
    );
  }

  // Double-send guard: claim the row by stamping sent_at, only if it is
  // still empty. A second click (or a second tab) finds it already claimed.
  // If the sent_at column hasn't been added yet (supabase/2026-10-review-
  // fixes.sql), the claim errors and we fall back to sending unguarded.
  const { data: claimed, error: claimError } = await supabase
    .from("email_triage")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", id)
    .is("sent_at", null)
    .select("id");
  if (!claimError && (claimed?.length ?? 0) === 0) {
    return NextResponse.json(
      { error: "This reply was already sent." },
      { status: 409 }
    );
  }

  try {
    await sendEmail({
      to: email.sender_email,
      subject: `Re: ${email.subject}`,
      body: draftText,
    });

    // Mark as sent in the database
    await supabase
      .from("email_triage")
      .update({
        review_status: email.edited_draft ? "edited" : "approved",
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id);

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send email";

    // Nothing went out, so release the claim and allow a retry.
    if (!claimError) {
      await supabase.from("email_triage").update({ sent_at: null }).eq("id", id);
    }

    if (message === "MS_NOT_CONNECTED") {
      return NextResponse.json(
        { error: "Outlook not connected. Please reconnect from the homepage." },
        { status: 401 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
