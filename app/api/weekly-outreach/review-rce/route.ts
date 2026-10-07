import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  deleteOutlookDraft,
  getMailboxAddress,
  getOutlookDraftThreadInfo,
  sendOutlookDraft,
  updateOutlookDraft,
  OUTLOOK_DRAFT_PERMISSION_MESSAGE,
  OUTLOOK_NOT_CONNECTED_MESSAGE,
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
      metadata.contextSource = "none";
      metadata.takeover = null;
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
      // Remember the thread and recipients so the short follow-up can reply
      // into the same chain later and check whether anyone answered.
      const threadInfo = await getOutlookDraftThreadInfo(metadata.outlookDraftId!).catch(() => ({
        conversationId: null,
        recipients: [],
      }));
      // Never send a reconnect to ourselves. This is what happened when the
      // chain's last message was ours and "reply" addressed it to the sender.
      const me = (await getMailboxAddress().catch(() => "")).toLowerCase();
      const to = threadInfo.recipients.map((r) => r.email.toLowerCase());
      if (to.length === 0 || (me && to.every((email) => email === me))) {
        return NextResponse.json(
          {
            error:
              "This draft is addressed to you, not the contact. Open it in Outlook, fix the To line, send from there, then mark it sent. Or dismiss and prepare again.",
            code: "ADDRESSED_TO_SELF",
          },
          { status: 409 },
        );
      }
      await sendOutlookDraft(metadata.outlookDraftId!);
      metadata.rceFirstSentAt = new Date().toISOString();
      metadata.conversationId = threadInfo.conversationId;
      metadata.recipients = threadInfo.recipients;
    }

    const { data: updated, error: updateError } = await supabase
      .from("weekly_outreach")
      .update({
        draft,
        status: body.action === "send" ? "sent" : "draft_ready",
        source_reference: writeWeeklyOutreachSourceMetadata(metadata),
      })
      .eq("id", item.id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json({ item: withWeeklyOutreachClientMetadata(updated) });
  } catch (reviewError) {
    const message = reviewError instanceof Error ? reviewError.message : "Could not review reconnect";
    if (message === "OUTLOOK_RECONNECT_REQUIRED" || message === "MS_NOT_CONNECTED") {
      return NextResponse.json(
        {
          error:
            message === "MS_NOT_CONNECTED"
              ? OUTLOOK_NOT_CONNECTED_MESSAGE
              : OUTLOOK_DRAFT_PERMISSION_MESSAGE,
          code: "OUTLOOK_RECONNECT_REQUIRED",
          reconnectUrl: "/api/microsoft/connect",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
