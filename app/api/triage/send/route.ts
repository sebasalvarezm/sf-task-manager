import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isAuthenticated } from "@/lib/auth";
import { sendEmail } from "@/lib/microsoft";

// POST /api/triage/send
// Send an approved/edited draft reply via Microsoft Graph (Outlook)
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
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

    if (message === "MS_NOT_CONNECTED") {
      return NextResponse.json(
        { error: "Outlook not connected. Please reconnect from the homepage." },
        { status: 401 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
