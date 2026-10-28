import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  deleteOutlookDraft,
  getMailboxIdentities,
  getOutlookDraftThreadInfo,
  isSelfAddress,
  sendOutlookDraft,
  setOutlookDraftRecipient,
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
import { listAccountContacts, runTakeoverSalesforce, type NewContactInput } from "@/lib/rce-takeover";

type ReviewAction = "save" | "send" | "dismiss" | "mark_sent" | "contacts" | "recipient";

export async function POST(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    id?: string;
    action?: ReviewAction;
    draft?: string;
    contactId?: string | null;
    newContact?: NewContactInput | null;
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

  // Takeover only: own the account, log today's RCE, open one for next week.
  // A normal RCE starts from an open task that the Tasks page already rolls.
  const takeoverSalesforce = async (sentDraft: string): Promise<string[]> => {
    const t = metadata.takeover;
    if (!t || t.salesforceDoneAt) return [];
    const email = metadata.recipients[0]?.email ?? t.contactEmail ?? null;
    const result = await runTakeoverSalesforce({
      accountId: item.sf_account_id,
      contactId: t.contactId ?? null,
      newContact: t.newContact ?? null,
      email,
      subject: metadata.replySubject ?? `Valstone / ${item.account_name}`,
      body: sentDraft,
      fromOpenTask: item.source === "tasks",
    });
    t.contactId = result.contactId;
    if (result.notes.length === 0) t.salesforceDoneAt = new Date().toISOString();
    return result.notes;
  };

  try {
    if (body.action === "contacts") {
      return NextResponse.json({ contacts: await listAccountContacts(item.sf_account_id) });
    }

    if (body.action === "recipient") {
      if (!metadata.takeover) return NextResponse.json({ error: "Only takeover emails can change contact here" }, { status: 400 });
      let email: string;
      let name: string | null;
      if (body.newContact) {
        const nc = body.newContact;
        if (!nc.firstName?.trim() || !nc.lastName?.trim() || !/^\S+@\S+\.\S+$/.test(nc.email ?? "")) {
          return NextResponse.json({ error: "First name, last name and a valid email are needed" }, { status: 400 });
        }
        email = nc.email.trim().toLowerCase();
        name = `${nc.firstName.trim()} ${nc.lastName.trim()}`;
        metadata.takeover.contactId = null;
        metadata.takeover.newContact = { firstName: nc.firstName.trim(), lastName: nc.lastName.trim(), email, title: nc.title?.trim() || null };
      } else {
        const contact = (await listAccountContacts(item.sf_account_id)).find((c) => c.id === body.contactId);
        if (!contact?.email) return NextResponse.json({ error: "That contact has no email in Salesforce" }, { status: 400 });
        email = contact.email;
        name = contact.name;
        metadata.takeover.contactId = contact.id;
        metadata.takeover.newContact = null;
      }
      metadata.takeover.contactName = name;
      metadata.takeover.contactEmail = email;
      metadata.recipients = [{ name, email }];
      if (metadata.outlookDraftId) await setOutlookDraftRecipient(metadata.outlookDraftId, email, name);
      const { data: updated, error: updateError } = await supabase
        .from("weekly_outreach")
        .update({ source_reference: writeWeeklyOutreachSourceMetadata(metadata) })
        .eq("id", item.id)
        .select("*")
        .single();
      if (updateError) throw new Error(updateError.message);
      return NextResponse.json({ item: withWeeklyOutreachClientMetadata(updated) });
    }

    if (body.action === "mark_sent") {
      // Sent by hand from Outlook: record it, and do the takeover bookkeeping.
      const sentDraft = body.draft?.trim() || item.draft || "";
      const notes = await takeoverSalesforce(sentDraft);
      const { data: updated, error: updateError } = await supabase
        .from("weekly_outreach")
        .update({ draft: sentDraft || null, status: "sent", source_reference: writeWeeklyOutreachSourceMetadata(metadata) })
        .eq("id", item.id)
        .select("*")
        .single();
      if (updateError) throw new Error(updateError.message);
      return NextResponse.json({ item: withWeeklyOutreachClientMetadata(updated), salesforceNotes: notes });
    }

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

    let salesforceNotes: string[] = [];
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
      const identities = await getMailboxIdentities().catch(() => new Set<string>());
      const to = threadInfo.recipients.map((r) => r.email.toLowerCase());
      if (to.length === 0 || (identities.size > 0 && to.every((email) => isSelfAddress(email, identities)))) {
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
      salesforceNotes = await takeoverSalesforce(draft);
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
    return NextResponse.json({ item: withWeeklyOutreachClientMetadata(updated), salesforceNotes });
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
