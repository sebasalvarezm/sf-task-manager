import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  createOutlookReplyDraft,
  getMailboxAddress,
  searchMailboxMessages,
} from "@/lib/microsoft";
import { fetchRecentAccountActivity } from "@/lib/salesforce-prep";
import {
  readWeeklyOutreachSourceMetadata,
  withWeeklyOutreachClientMetadata,
  writeWeeklyOutreachSourceMetadata,
  type WeeklyOutreachItem,
} from "@/lib/weekly-outreach";

function domainFromWebsite(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = (await request.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: "Missing row id" }, { status: 400 });
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("weekly_outreach").select("*").eq("id", id).single();
  if (error || !data) return NextResponse.json({ error: "Weekly Outreach row not found" }, { status: 404 });
  const item = data as WeeklyOutreachItem;
  if (item.outreach_type !== "RCE") return NextResponse.json({ error: "Only RCE rows use Outlook reconnect drafting" }, { status: 400 });
  if (!readWeeklyOutreachSourceMetadata(item.source_reference).rceDraftEnabled) {
    return NextResponse.json(
      { error: "This RCE is opted out of drafting", code: "RCE_DRAFT_SKIPPED" },
      { status: 409 },
    );
  }
  const client = getAnthropicClient();
  if (!client) return NextResponse.json({ error: "AI service not configured" }, { status: 503 });

  try {
    const domain = domainFromWebsite(item.website);
    const [domainEmails, nameEmails, personalAngleEmails, sfActivity, mailboxAddress] = await Promise.all([
      domain ? searchMailboxMessages(domain, 50).catch(() => []) : Promise.resolve([]),
      searchMailboxMessages(item.account_name, 50).catch(() => []),
      searchMailboxMessages("100th birthday", 12).catch(() => []),
      fetchRecentAccountActivity(item.sf_account_id).catch(() => []),
      getMailboxAddress().catch(() => ""),
    ]);
    const relationshipEmails = [...domainEmails, ...nameEmails]
      .filter((email, index, all) => all.findIndex((candidate) => candidate.id === email.id) === index)
      .sort((a, b) => new Date(a.sentDateTime).getTime() - new Date(b.sentDateTime).getTime())
      .slice(-50);
    const relationshipText = relationshipEmails.map((message) =>
      `${message.sentDateTime} | ${message.fromEmail} -> ${message.toEmails.join(", ")} | ${message.subject}\n${message.bodyText.slice(0, 1800)}`,
    ).join("\n\n");
    const sentStyleExamples = relationshipEmails
      .filter((message) => mailboxAddress && message.fromEmail === mailboxAddress)
      .slice(-12)
      .map((message) => `${message.subject}\n${message.bodyText.slice(0, 1600)}`)
      .join("\n\n");
    const personalAngleText = personalAngleEmails
      .filter((message) => !mailboxAddress || message.fromEmail === mailboxAddress)
      .map((message) => `${message.subject}\n${message.bodyText.slice(0, 1200)}`)
      .join("\n\n");
    const replyTarget = [...relationshipEmails]
      .reverse()
      .find((message) => message.fromEmail && message.fromEmail !== mailboxAddress);
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      messages: [{ role: "user", content: `Draft a reconnect email for an M&A professional. Match Sebastian's actual sent-email voice in the evidence: concise, natural, personable, and specific. Use his vocabulary, sentence length, contractions, and level of formality. Never use an em dash. Never write "I would welcome a conversation", "I would value a conversation", "I hope this message finds you well", generic praise, AI jargon, hype, or anything corny. Do not invent history or claim the recipient said something unless the thread supports it. Do not include a subject line, greeting, or signature because this will be inserted into an existing Outlook reply draft.

Company: ${item.account_name}
Salesforce activity:
${sfActivity.join("\n") || "No Salesforce activity available"}

Relevant Outlook exchanges (received and sent):
${relationshipText || "No relevant Outlook thread found"}

Sebastian's sent-email style examples from this relationship:
${sentStyleExamples || "No sent examples found in the relationship search"}

Optional recent personal-angle examples from the user's sent mail. Reuse only if the evidence makes the wording clear and it fits naturally; otherwise ignore it:
${personalAngleText || "No personal-angle example found"}

Return ONLY JSON:
{
  "contextSummary": "Maximum 55 words. State when contact last occurred, exactly where the conversation stopped, the concrete decision/objection/promise, and the most useful reconnect angle. It must be readable in under 30 seconds.",
  "draft": "A short, natural reconnect email body in Sebastian's demonstrated voice, generally 50-120 words. No subject, greeting, signature, em dash, generic CTA, or invented detail."
}` }],
    });
    const text = message.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("\n");
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as { contextSummary: string; draft: string };
    const metadata = readWeeklyOutreachSourceMetadata(item.source_reference);
    let replySubject = metadata.replySubject;
    let outlookWarning: string | null = null;
    if (replyTarget) {
      metadata.replyToMessageId = replyTarget.id;
      metadata.replySubject = replyTarget.subject;
      replySubject = replyTarget.subject;
      try {
        const outlookDraft = await createOutlookReplyDraft(replyTarget.id, parsed.draft);
        metadata.outlookDraftId = outlookDraft.id;
        metadata.replyToMessageId = replyTarget.id;
        metadata.replySubject = outlookDraft.subject;
        replySubject = outlookDraft.subject;
      } catch (draftError) {
        if (draftError instanceof Error && draftError.message === "OUTLOOK_RECONNECT_REQUIRED") {
          outlookWarning =
            "A copyable reconnect draft is ready. Outlook approval is still pending, so paste it into the existing email chain manually.";
        } else {
          throw draftError;
        }
      }
    }
    const { data: updated, error: updateError } = await supabase
      .from("weekly_outreach")
      .update({
        context_summary: parsed.contextSummary,
        draft: parsed.draft,
        status: "draft_ready",
        source_reference: writeWeeklyOutreachSourceMetadata(metadata),
      })
      .eq("id", id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json({
      item: withWeeklyOutreachClientMetadata(updated),
      warning:
        outlookWarning ??
        (replyTarget
          ? null
          : "No received Outlook thread was found. A copyable draft is ready, but choose the correct chain manually."),
      replySubject,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not prepare reconnect";
    if (message === "OUTLOOK_RECONNECT_REQUIRED") {
      return NextResponse.json(
        {
          error: "Reconnect Outlook once to allow editable reply drafts. No email was sent.",
          code: "OUTLOOK_RECONNECT_REQUIRED",
          reconnectUrl: "/api/microsoft/connect",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
