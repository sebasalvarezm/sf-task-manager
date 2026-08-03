import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  deleteOutlookDraft,
  sendOutlookDraft,
  updateOutlookDraft,
} from "@/lib/microsoft";
import {
  readWeeklyOutreachSourceMetadata,
  withWeeklyOutreachClientMetadata,
  writeWeeklyOutreachSourceMetadata,
  type WeeklyOutreachItem,
} from "@/lib/weekly-outreach";

type ReviewAction = "save" | "send" | "dismiss";

export async function POST(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    id?: string;
    action?: ReviewAction;
    draft?: string;
  };
  if (!body.id || !body.action) {
    return NextResponse.json({ error: "Missing row or review action" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_outreach")
    .select("*")
    .eq("id", body.id)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "Weekly Outreach row not found" }, { status: 404 });
  }
  const item = data as WeeklyOutreachItem;
  if (item.outreach_type !== "RCE") {
    return NextResponse.json({ error: "Only RCE rows use Outlook reply review" }, { status: 400 });
  }
  const metadata = readWeeklyOutreachSourceMetadata(item.source_reference);

  try {
    if (body.action === "dismiss") {
      if (metadata.outlookDraftId) await deleteOutlookDraft(metadata.outlookDraftId);
      metadata.outlookDraftId = null;
      metadata.replyToMessageId = null;
      metadata.replySubject = null;
      const { data: updated, error: updateError } = await supabase
        .from("weekly_outreach")
        .update({
          draft: null,
          context_summary: null,
          status: "queued",
          source_reference: writeWeeklyOutreachSourceMetadata(metadata),
        })
        .eq("id", item.id)
        .select("*")
        .single();
      if (updateError) throw new Error(updateError.message);
      return NextResponse.json({ item: withWeeklyOutreachClientMetadata(updated) });
    }

    const draft = body.draft?.trim();
    if (!draft) {
      return NextResponse.json({ error: "The reconnect draft is empty" }, { status: 400 });
    }

    if (metadata.outlookDraftId) {
      await updateOutlookDraft(metadata.outlookDraftId, draft);
    } else if (body.action === "send") {
      return NextResponse.json(
        {
          error:
            "No Outlook reply draft is attached to this row. Prepare it again after reconnecting Outlook.",
          code: "NO_OUTLOOK_DRAFT",
        },
        { status: 409 },
      );
    }

    if (body.action === "send") {
      await sendOutlookDraft(metadata.outlookDraftId!);
    }

    const { data: updated, error: updateError } = await supabase
      .from("weekly_outreach")
      .update({
        draft,
        status: body.action === "send" ? "sent" : "draft_ready",
      })
      .eq("id", item.id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json({ item: withWeeklyOutreachClientMetadata(updated) });
  } catch (reviewError) {
    const message = reviewError instanceof Error ? reviewError.message : "Could not review reconnect";
    if (message === "OUTLOOK_RECONNECT_REQUIRED") {
      return NextResponse.json(
        {
          error: "Reconnect Outlook once to edit reply drafts.",
          code: "OUTLOOK_RECONNECT_REQUIRED",
          reconnectUrl: "/api/microsoft/connect",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
