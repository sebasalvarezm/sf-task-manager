import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  createOutlookFollowUpDraft,
  fetchEmailThread,
  getMailboxAddress,
  sendOutlookDraft,
} from "@/lib/microsoft";
import {
  buildRceFollowUp,
  daysBetween,
  firstNameFrom,
  firstNameFromGreeting,
} from "@/lib/rce-followup";
import {
  readWeeklyOutreachSourceMetadata,
  withWeeklyOutreachClientMetadata,
  writeWeeklyOutreachSourceMetadata,
  type WeeklyOutreachItem,
} from "@/lib/weekly-outreach";

/**
 * The short second email after a reconnect.
 *
 *  preview: look at the Outlook thread the first email went into, report
 *           whether anyone on the other side has replied since, and return
 *           the follow-up text (one of Seb's own templates, first name filled).
 *  send:    create a reply draft in that thread addressed to the original
 *           recipients, with the (possibly edited) text, and send it.
 *
 * Nothing is sent without an explicit "send" action from the review box.
 */

type FollowUpAction = "preview" | "send";

export async function POST(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    id?: string;
    action?: FollowUpAction;
    body?: string;
    /** send only: go ahead even though a reply was detected in preview. */
    ignoreReply?: boolean;
  };
  if (!body.id || !body.action) {
    return NextResponse.json({ error: "Missing row or action" }, { status: 400 });
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
    return NextResponse.json({ error: "Only RCE rows have a follow-up" }, { status: 400 });
  }
  const metadata = readWeeklyOutreachSourceMetadata(item.source_reference);
  if (metadata.rceSecondSent) {
    return NextResponse.json({ error: "The follow-up was already sent" }, { status: 409 });
  }
  if (!metadata.rceFirstSentAt || !metadata.conversationId) {
    return NextResponse.json(
      {
        error:
          "The first email was not sent from the tool, so its Outlook thread is unknown. Send the follow-up from Outlook and mark it manually.",
        code: "NOT_TRACKED",
      },
      { status: 409 },
    );
  }

  try {
    const [thread, mailbox] = await Promise.all([
      fetchEmailThread(metadata.conversationId),
      getMailboxAddress().catch(() => ""),
    ]);
    const me = mailbox.toLowerCase();
    const sentAt = new Date(metadata.rceFirstSentAt).getTime();
    const recipientEmails = new Set(metadata.recipients.map((r) => r.email));

    // Anything from someone other than us after the first email counts as a reply.
    const replies = thread.filter(
      (m) =>
        m.from.email &&
        m.from.email !== me &&
        new Date(m.receivedDateTime).getTime() > sentAt - 60_000,
    );
    const replyFromRecipient = replies.find((m) => recipientEmails.has(m.from.email)) ?? replies[0] ?? null;

    // Reply into the most recent message in the chain so Outlook threads it.
    const latest = thread[thread.length - 1] ?? null;

    const recipient = metadata.recipients[0] ?? null;
    const firstName =
      firstNameFrom(recipient?.name) ?? firstNameFromGreeting(item.draft) ?? null;

    if (body.action === "preview") {
      const built = buildRceFollowUp({ seed: item.id, firstName, now: new Date() });
      return NextResponse.json({
        body: built.body,
        firstNamePlaceholder: built.usedPlaceholder,
        daysSinceFirst: daysBetween(metadata.rceFirstSentAt, new Date()),
        firstSentAt: metadata.rceFirstSentAt,
        recipients: metadata.recipients,
        threadFound: Boolean(latest),
        replyDetected: replyFromRecipient
          ? {
              from: replyFromRecipient.from.name || replyFromRecipient.from.email,
              at: replyFromRecipient.receivedDateTime,
              preview: replyFromRecipient.bodyPreview.slice(0, 160),
            }
          : null,
      });
    }

    // send
    const text = body.body?.trim();
    if (!text) return NextResponse.json({ error: "The follow-up is empty" }, { status: 400 });
    if (/\[First name\]/i.test(text)) {
      return NextResponse.json({ error: "Fill in the first name before sending" }, { status: 400 });
    }
    if (replyFromRecipient && !body.ignoreReply) {
      return NextResponse.json(
        { error: `${replyFromRecipient.from.name || replyFromRecipient.from.email} already replied. Read it first.`, code: "REPLY_DETECTED" },
        { status: 409 },
      );
    }
    if (!latest) {
      return NextResponse.json(
        { error: "The original thread could not be found in Outlook.", code: "THREAD_MISSING" },
        { status: 409 },
      );
    }
    if (metadata.recipients.length === 0) {
      return NextResponse.json(
        { error: "The original recipients are unknown, so the follow-up cannot be addressed.", code: "NO_RECIPIENTS" },
        { status: 409 },
      );
    }

    const draft = await createOutlookFollowUpDraft({
      replyToMessageId: latest.id,
      to: metadata.recipients,
      body: text,
    });
    await sendOutlookDraft(draft.id);

    metadata.rceSecondSent = true;
    const { data: updated, error: updateError } = await supabase
      .from("weekly_outreach")
      .update({
        status: "sent",
        source_reference: writeWeeklyOutreachSourceMetadata(metadata),
      })
      .eq("id", item.id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json({ item: withWeeklyOutreachClientMetadata(updated), sent: true });
  } catch (followUpError) {
    const message = followUpError instanceof Error ? followUpError.message : "Could not prepare follow-up";
    if (message === "MS_NOT_CONNECTED" || message === "OUTLOOK_RECONNECT_REQUIRED") {
      return NextResponse.json(
        { error: "Reconnect Outlook to send follow-ups.", code: "OUTLOOK_RECONNECT_REQUIRED", reconnectUrl: "/api/microsoft/connect" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
