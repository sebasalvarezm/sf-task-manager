import { NextResponse } from "next/server";
import { trackedCreate } from "@/lib/model-cost";
import { fetchContactsForAccounts } from "@/lib/salesforce-contacts";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient, MODELS } from "@/lib/anthropic";
import {
  createOutlookNewDraft,
  deleteOutlookDraftIfUnsent,
  createOutlookReplyDraft,
  getMailboxIdentities,
  isSelfAddress,
  getMailboxAddress,
  searchMailboxMessages,
  OUTLOOK_DRAFT_PERMISSION_MESSAGE,
  OUTLOOK_NOT_CONNECTED_MESSAGE,
} from "@/lib/microsoft";
import { fetchAccountHistory, type AccountHistory } from "@/lib/salesforce-account-history";
import { matchRceReplyThread } from "@/lib/rce-thread-match";
import { greetingName } from "@/lib/rce-followup";
import {
  extractOutreachParagraph,
  findGroupFileName,
  loadGroupFiles,
  matchGroup,
  scrapeWithJina,
} from "@/lib/scout";
import {
  readWeeklyOutreachSourceMetadata,
  withWeeklyOutreachClientMetadata,
  writeWeeklyOutreachSourceMetadata,
  type WeeklyOutreachContextSource,
  type WeeklyOutreachItem,
  type WeeklyOutreachTakeover,
} from "@/lib/weekly-outreach";

/**
 * Prepares one RCE (reconnect) draft. Context is found in two tiers:
 *
 *  1. Outlook. Search the user's own mailbox for a chain with the company. If
 *     one clears the evidence bar (lib/rce-thread-match.ts), the draft is a
 *     reply into that chain, exactly as before.
 *  2. Salesforce. If no chain clears the bar, read the account timeline
 *     (Task + EmailMessage, with names). If a colleague has exchanged with the
 *     target and the user has not, this is a takeover: classify the company
 *     into a portfolio sub-group and draft a fresh email to the contact that
 *     names the colleague, the date, and why the sub-group fit matters.
 *
 * Both tiers are always fetched (the Salesforce lines help even when Outlook
 * wins), but the website scrape and group classification run only in takeover
 * mode, since they cost web fetches and an extra model call.
 */

function domainFromWebsite(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function domainOfMailbox(mailboxAddress: string): string | null {
  const domain = mailboxAddress.split("@")[1];
  return domain ? domain.toLowerCase() : null;
}

function formatDateForEmail(isoDate: string): string {
  if (!isoDate) return "earlier this year";
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

type GroupContext = {
  groupName: string | null;
  mainGroup: string | null;
  confidence: number | null;
  /** The sub-group's "Core Outreach Paragraph", which explains why Valstone cares. */
  outreachParagraph: string | null;
};

/** Reuse the sourcing tool's classifier so takeover emails name the right sub-group. */
async function classifyCompany(
  client: NonNullable<ReturnType<typeof getAnthropicClient>>,
  website: string | null,
): Promise<GroupContext> {
  const empty: GroupContext = { groupName: null, mainGroup: null, confidence: null, outreachParagraph: null };
  if (!website) return empty;
  const groups = loadGroupFiles();
  if (Object.keys(groups).length === 0) return empty;
  const siteText = await scrapeWithJina(website, 12000).catch(() => "");
  if (!siteText || siteText.length < 300) return empty;
  const match = await matchGroup(client, siteText, groups).catch(() => null);
  if (!match || !match.matched || !match.group) {
    return { ...empty, confidence: match?.confidence ?? null };
  }
  const fileKey = findGroupFileName(match.group, groups);
  return {
    groupName: match.group,
    mainGroup: match.mainGroup,
    confidence: match.confidence,
    outreachParagraph: fileKey ? extractOutreachParagraph(groups[fileKey]) : null,
  };
}

const SHARED_RULES = `Match Sebastian's actual sent-email voice in the evidence: concise, natural, personable, and specific. Use his vocabulary, sentence length, contractions, and level of formality. Never use an em dash. Never write "circle back", "touch base", "I would welcome a conversation", "I would value a conversation", "I hope this message finds you well", "hope all is well", "at your earliest convenience", "looking forward to hearing from you", "please do not hesitate", generic praise, AI jargon, hype, or anything corny. Write "thank you", never "thanks". Open with the point ("Just checking in", "Wanted to follow up", "Thank you for the quick reply"), not a pleasantry. Do not invent history or claim the recipient said something unless the evidence supports it. Never describe Seb as "taking over" a relationship. When there is a recent Valstone deal in the same space in the evidence, it is the best reason to reconnect ("We've been busy in rail since. In July we acquired Nascent Technology..."); use it in one or two sentences, never invent one.`;

function replyPrompt(input: {
  item: WeeklyOutreachItem;
  history: AccountHistory;
  relationshipText: string;
  sentStyleExamples: string;
  personalAngleText: string;
  replyTo: { email: string; subject: string; sentAt: string } | null;
}): string {
  const replyLine = input.replyTo
    ? `This reply goes into the Outlook thread "${input.replyTo.subject}" (last message from ${input.replyTo.email} on ${input.replyTo.sentAt.slice(0, 10)}). Write it for that person and that thread; do not address anyone else and do not use a name from a different thread.`
    : "";
  return `Draft a reconnect email for an M&A professional. ${SHARED_RULES} Do not include a subject line, greeting, or signature because this will be inserted into an existing Outlook reply draft. ${replyLine}

Company: ${input.item.account_name}
Salesforce activity timeline (newest first; "(me)" is Sebastian, "(colleague)" is a teammate):
${input.history.lines.join("\n\n") || "No Salesforce activity available"}

Relevant Outlook exchanges (received and sent):
${input.relationshipText || "No relevant Outlook thread found"}

Sebastian's sent-email style examples from this relationship:
${input.sentStyleExamples || "No sent examples found in the relationship search"}

Optional recent personal-angle examples from the user's sent mail. Reuse only if the evidence makes the wording clear and it fits naturally; otherwise ignore it:
${input.personalAngleText || "No personal-angle example found"}

Return ONLY JSON:
{
  "contextSummary": "Maximum 55 words. State when contact last occurred, exactly where the conversation stopped, the concrete decision/objection/promise, and the most useful reconnect angle. It must be readable in under 30 seconds.",
  "draft": "A short, natural reconnect email body in Sebastian's demonstrated voice, generally 50-120 words. No subject, greeting, signature, em dash, generic CTA, or invented detail."
}`;
}

/**
 * Seb's own rewrite of a takeover draft (TekTracking, Oct 2026): a follow-up,
 * not a "taking over" note, with the group's latest deal as the reason to
 * write. Used as the model for every takeover email.
 */
const TAKEOVER_EXAMPLE = `Hi Greg,

I'm Sebastian at Valstone, following up on your conversation with my colleague Dan Malouf back in April. The timing wasn't right for a meeting then, so I wanted to check back in.

We've been busy in rail since. In July we acquired Nascent Technology, which adds terminal gate automation to PS Technology and GeoMetrix Rail Logistics, our carve-outs from Union Pacific and Amsted Rail. TekTracking keeps coming up as we build that out.

Would you be open to a quick call in the coming weeks? Happy to keep it informal.

Best,
Seb`;

function takeoverPrompt(input: {
  item: WeeklyOutreachItem;
  history: AccountHistory;
  group: GroupContext;
  sentStyleExamples: string;
}): string {
  const takeover = input.history.takeover!;
  const contact = takeover.contactName ?? "the contact";
  const when = formatDateForEmail(takeover.lastExchangeDate);
  return `Draft a short email from Sebastian (Seb) at Valstone, following up on a conversation his colleague had with this company. ${SHARED_RULES}

Situation: ${takeover.colleagueName} exchanged emails with ${contact} at ${input.item.account_name} in ${when}. Seb has never written to ${contact}. This is a NEW email, not a reply. Do not include a subject line in the body.

Write it the way Seb wrote this one, which he rewrote himself and is the model to follow for structure, length and tone:
---
${TAKEOVER_EXAMPLE}
---
Rules that come from that example:
1. Frame it as a follow-up on the colleague's conversation ("following up on your conversation with my colleague ${takeover.colleagueName} back in ${when.split(" ")[0]}"), never as "taking over the relationship" or "I've taken over".
2. Say where it left off in a few plain words, only as far as the timeline below supports (e.g. "The timing wasn't right for a meeting then, so I wanted to check back in.").
3. Give one concrete reason to write now: Valstone's own progress in the sub-group. Name one or two real acquisitions from the sub-group paragraph below (the "Key steps" sentence), most recent first, and what they add. Then one short line tying ${input.item.account_name} to it ("${input.item.account_name} keeps coming up as we build that out."). Never invent a deal, a date or a detail that is not in the paragraph or the timeline. Do not list the group's capabilities.
4. A plain, low-pressure ask for a call in the coming weeks, then "Happy to keep it informal." or similar.
5. Greeting "Hi ${takeover.contactFirstName ?? contact}," (a natural short form is fine if the timeline uses one). Close with "Best," then "Seb" on its own line.
6. 70 to 110 words in the body. Short paragraphs.

Company: ${input.item.account_name}${input.item.website ? ` (${input.item.website})` : ""}

Salesforce activity timeline (newest first; "(me)" is Sebastian, "(colleague)" is a teammate). This is the only history that exists, so do not claim more than it shows:
${input.history.lines.join("\n\n") || "No Salesforce activity available"}

Portfolio sub-group classification: ${
    input.group.groupName
      ? `${input.group.groupName}${input.group.mainGroup ? ` (within ${input.group.mainGroup})` : ""}, confidence ${input.group.confidence ?? "unknown"}/100`
      : "No confident sub-group match. Describe Valstone's interest in general terms tied to what the company does, without naming a sub-group or a deal."
  }
Sub-group outreach paragraph (facts to draw the acquisitions from; do not paste it):
${input.group.outreachParagraph || "None available"}

Seb's sent-email style examples (other relationships; use for voice only, never for facts):
${input.sentStyleExamples || "No sent examples available"}

Return ONLY JSON:
{
  "contextSummary": "Maximum 55 words. Start with 'Follow-up on ${takeover.colleagueName}'s conversation.' Then state when the last exchange happened, where it stopped, and the angle (which acquisition). Readable in under 30 seconds.",
  "subject": "Short and specific, like 'Valstone / ${input.item.account_name}' or a 4-7 word line about the group, no colons.",
  "draft": "The email: greeting, body, 'Best,' and 'Seb'. No em dash, no invented detail."
}`;
}

// Several Outlook searches, Salesforce history and an AI draft in one call.
export const maxDuration = 300;

/** Subject for a fresh email when there is no chain to reply into. */
function freshSubject(accountName: string): string {
  return `Valstone / ${accountName} catch up`;
}

/** A new email needs a greeting; the reply prompt is told not to write one. */
function ensureGreeting(draft: string, firstName: string | null): string {
  const body = draft.trimStart();
  if (/^(hi|hey|hello|dear|good (morning|afternoon|evening))\b/i.test(body)) return body;
  return `Hi ${firstName ?? "there"},\n\n${body}`;
}

type FreshRecipient = { email: string; name: string | null; firstName: string | null; why: string };

async function pickFreshRecipient(accountId: string | null, history: AccountHistory): Promise<FreshRecipient | null> {
  const first = (name: string | null) => (name ? name.trim().split(/\s+/)[0] || null : null);
  const answered = history.entries.find((e) => e.isEmail && e.direction === "in" && e.contactEmail);
  if (answered?.contactEmail) {
    return { email: answered.contactEmail, name: answered.contactName, firstName: first(answered.contactName), why: `answered Valstone on ${answered.date}` };
  }
  const written = history.entries.find((e) => e.isEmail && e.contactEmail);
  if (written?.contactEmail) {
    return { email: written.contactEmail, name: written.contactName, firstName: first(written.contactName), why: `last written to on ${written.date}` };
  }
  if (!accountId) return null;
  const contacts = (await fetchContactsForAccounts([accountId])).get(accountId) ?? [];
  const rank = (title: string | null) => {
    const t = (title ?? "").toLowerCase();
    if (/founder/.test(t)) return 1;
    if (/\bceo\b|chief executive/.test(t)) return 2;
    if (/president|owner|managing director/.test(t)) return 3;
    if (/\bcto\b|\bcoo\b|\bcfo\b|chief/.test(t)) return 4;
    return 9;
  };
  const best = contacts.filter((c) => c.Email).sort((a, b) => rank(a.Title) - rank(b.Title))[0];
  if (!best?.Email) return null;
  return { email: best.Email.toLowerCase(), name: best.Name ?? null, firstName: best.FirstName ?? first(best.Name ?? null), why: `most senior Salesforce contact${best.Title ? `, ${best.Title}` : ""}` };
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
    // Outlook not connected must stop here with a clear message. Before, every
    // lookup below quietly returned nothing and a generic draft was saved.
    const mailboxAddress = await getMailboxAddress().catch((mailboxError: unknown) => {
      if (mailboxError instanceof Error && mailboxError.message === "MS_NOT_CONNECTED") {
        throw mailboxError;
      }
      return "";
    });
    // The account's Salesforce contacts. Their addresses find the right chain
    // even when the owner writes from a holding company or personal domain.
    const contactEmails: string[] = item.sf_account_id
      ? await fetchContactsForAccounts([item.sf_account_id])
          .then((byAccount) =>
            (byAccount.get(item.sf_account_id!) ?? [])
              .map((c) => (c.Email ?? "").toLowerCase())
              .filter(Boolean),
          )
          .catch(() => [])
      : [];
    const [domainEmails, nameEmails, contactEmailsFound, personalAngleEmails, history] = await Promise.all([
      domain ? searchMailboxMessages(domain, 50).catch(() => []) : Promise.resolve([]),
      searchMailboxMessages(item.account_name, 50).catch(() => []),
      Promise.all(contactEmails.slice(0, 5).map((email) => searchMailboxMessages(email, 25).catch(() => []))).then((lists) => lists.flat()),
      searchMailboxMessages("100th birthday", 12).catch(() => []),
      fetchAccountHistory(item.sf_account_id, { valstoneDomain: domainOfMailbox(mailboxAddress) }).catch(
        (): AccountHistory => ({ entries: [], lines: [], currentUserName: null, takeover: null }),
      ),
    ]);
    for (const entry of history.entries) {
      if (entry.contactEmail) contactEmails.push(entry.contactEmail.toLowerCase());
    }
    // Who a fresh email should go to when there is no chain of our own to reply
    // into: the person who answered Valstone most recently, then whoever we last
    // wrote to, then the most senior Salesforce contact with an email.
    const freshRecipient = await pickFreshRecipient(item.sf_account_id, history).catch(() => null);
    const relationshipEmails = [...domainEmails, ...nameEmails, ...contactEmailsFound]
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

    // Tier 1: the user's own Outlook chain, scored on evidence.
    const threadMatch = matchRceReplyThread(relationshipEmails, item.account_name, domain, mailboxAddress, contactEmails);
    const replyTarget = threadMatch.replyTarget;

    // Tier 2: a colleague's exchange in Salesforce, only when Outlook has nothing.
    const isTakeover = !replyTarget && history.takeover !== null;
    const contextSource: WeeklyOutreachContextSource = replyTarget ? "outlook" : isTakeover ? "salesforce" : "none";

    let group: GroupContext = { groupName: null, mainGroup: null, confidence: null, outreachParagraph: null };
    if (isTakeover) {
      // Style examples for a fresh email come from the user's own sent mail in
      // general, since by definition there is none in this relationship.
      group = await classifyCompany(client, item.website);
    }
    const generalStyleExamples = isTakeover && !sentStyleExamples
      ? (await searchMailboxMessages("reconnect", 12).catch(() => []))
          .filter((message) => mailboxAddress && message.fromEmail === mailboxAddress)
          .slice(-8)
          .map((message) => `${message.subject}\n${message.bodyText.slice(0, 1400)}`)
          .join("\n\n")
      : sentStyleExamples;

    const prompt = isTakeover
      ? takeoverPrompt({ item, history, group, sentStyleExamples: generalStyleExamples })
      : replyPrompt({
          item,
          history,
          relationshipText,
          sentStyleExamples,
          personalAngleText,
          replyTo: replyTarget
            ? { email: replyTarget.fromEmail, subject: replyTarget.subject, sentAt: replyTarget.sentDateTime }
            : null,
        });

    const message = await trackedCreate(client, "rce_draft", {
      model: MODELS.drafting,
      max_tokens: 1800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("\n");
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as {
      contextSummary: string;
      draft: string;
      subject?: string;
    };
    if (!isTakeover && typeof parsed.draft === "string") {
      // The model is told not to greet, because the name it picks can come from
      // the wrong thread. The greeting is added here from the person the reply
      // actually goes to, so every draft opens "Hi <first name>,".
      parsed.draft = parsed.draft.replace(/^\s*(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^\n]*\n+/i, "").trimStart();
      const first = replyTarget ? greetingName(replyTarget.fromName, replyTarget.fromEmail) : null;
      if (first) parsed.draft = `Hi ${first},\n\n${parsed.draft}`;
    }

    const metadata = readWeeklyOutreachSourceMetadata(item.source_reference);
    // Preparing again replaces the Outlook draft. The previous one is removed
    // further down, only once the new draft exists (and only if Outlook still
    // has it as an unsent draft), so a failed attempt never loses the old one.
    const previousDraftId =
      metadata.outlookDraftId && !metadata.rceFirstSentAt ? metadata.outlookDraftId : null;
    metadata.replyConfidence = threadMatch.confidence;
    metadata.replyReason = threadMatch.reason || null;
    metadata.contextSource = contextSource;
    metadata.takeover = null;
    let replySubject: string | null = null;
    let outlookWarning: string | null = null;

    if (!replyTarget) {
      // Drop any chain a previous run attached, so a wrong subject cannot linger
      // and Approve & Send stays disabled until a chain exists.
      metadata.replyToMessageId = null;
      metadata.replySubject = null;
      metadata.outlookDraftId = null;
    }

    if (replyTarget) {
      metadata.replyToMessageId = replyTarget.id;
      metadata.replySubject = replyTarget.subject;
      replySubject = replyTarget.subject;
      // The people on the other side of the chain. If the matched message is
      // one we sent, that is who it went to; otherwise, who sent it.
      const identities = await getMailboxIdentities().catch(() => new Set<string>([mailboxAddress.toLowerCase()]));
      const externalEmails = (
        isSelfAddress(replyTarget.fromEmail, identities)
          ? replyTarget.toEmails
          : [replyTarget.fromEmail]
      )
        .map((email) => email.toLowerCase())
        .filter((email) => email && !isSelfAddress(email, identities));
      const fallbackRecipients = [...new Set(externalEmails)].map((email) => ({ name: null, email }));
      try {
        const outlookDraft = await createOutlookReplyDraft(replyTarget.id, parsed.draft, {
          mailbox: mailboxAddress,
          selfAddresses: identities,
          fallbackRecipients,
        });
        metadata.outlookDraftId = outlookDraft.id;
        metadata.replySubject = outlookDraft.subject;
        metadata.recipients = outlookDraft.recipients ?? fallbackRecipients;
        replySubject = outlookDraft.subject;
      } catch (draftError) {
        if (draftError instanceof Error && draftError.message === "OUTLOOK_RECONNECT_REQUIRED") {
          outlookWarning =
            "A copyable reconnect draft is ready, but Outlook didn't allow creating the draft. Reconnect Outlook and prepare again, or paste it into the existing email chain yourself.";
        } else {
          throw draftError;
        }
      }
    } else if (isTakeover && history.takeover) {
      const takeover = history.takeover;
      const takeoverMetadata: WeeklyOutreachTakeover = {
        colleagueName: takeover.colleagueName,
        contactName: takeover.contactName,
        contactEmail: takeover.contactEmail,
        lastExchangeDate: takeover.lastExchangeDate,
        groupName: group.groupName,
        mainGroup: group.mainGroup,
        groupConfidence: group.confidence,
      };
      metadata.takeover = takeoverMetadata;
      const subject = freshSubject(item.account_name);
      replySubject = subject;
      metadata.replySubject = subject;
      const to = takeover.contactEmail ?? freshRecipient?.email ?? null;
      if (to) {
        // A real new-message draft, so Save and Approve & Send work like a reply.
        try {
          const outlookDraft = await createOutlookNewDraft({
            to,
            subject,
            body: ensureGreeting(parsed.draft, takeover.contactFirstName ?? freshRecipient?.firstName ?? null),
          });
          metadata.recipients = [{ name: takeover.contactName ?? freshRecipient?.name ?? null, email: to }];
          metadata.outlookDraftId = outlookDraft.id;
          replySubject = outlookDraft.subject;
          metadata.replySubject = outlookDraft.subject;
        } catch (draftError) {
          if (draftError instanceof Error && draftError.message === "OUTLOOK_RECONNECT_REQUIRED") {
            outlookWarning =
              "A copyable takeover draft is ready, but Outlook didn't allow creating the draft. Reconnect Outlook and prepare again, or paste it into a new email yourself.";
          } else {
            throw draftError;
          }
        }
      } else {
        outlookWarning = `Salesforce has no email address for ${takeover.contactName ?? "the contact"}, so this draft is copy and paste only. Add the contact's email in Salesforce and re-prepare to get a sendable draft.`;
      }
    } else {
      // No chain of our own in Outlook and no colleague exchange either: still
      // give Seb a sendable new email instead of a copy-and-paste draft.
      const subject = freshSubject(item.account_name);
      replySubject = subject;
      metadata.replySubject = subject;
      if (freshRecipient) {
        try {
          const outlookDraft = await createOutlookNewDraft({
            to: freshRecipient.email,
            subject,
            body: ensureGreeting(parsed.draft, freshRecipient.firstName),
          });
          metadata.outlookDraftId = outlookDraft.id;
          metadata.recipients = [{ name: freshRecipient.name, email: freshRecipient.email }];
          replySubject = outlookDraft.subject;
          metadata.replySubject = outlookDraft.subject;
          outlookWarning = `No earlier chain found in your Outlook, so this is a new email to ${freshRecipient.name ?? freshRecipient.email} (${freshRecipient.why}).`;
        } catch (draftError) {
          if (draftError instanceof Error && draftError.message === "OUTLOOK_RECONNECT_REQUIRED") {
            outlookWarning = "A copyable draft is ready, but Outlook didn't allow creating the draft. Reconnect Outlook and prepare again.";
          } else {
            throw draftError;
          }
        }
      } else {
        outlookWarning = "No earlier chain in your Outlook and no contact with an email on the Salesforce account, so this draft is copy and paste only.";
      }
    }

    if (previousDraftId && metadata.outlookDraftId !== previousDraftId) {
      await deleteOutlookDraftIfUnsent(previousDraftId).catch(() => {});
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

    const takeoverNote = metadata.takeover
      ? `Takeover from ${metadata.takeover.colleagueName}, last exchange ${metadata.takeover.lastExchangeDate}.${
          metadata.takeover.groupName
            ? ` Classified as ${metadata.takeover.groupName}${metadata.takeover.groupConfidence !== null ? ` (${metadata.takeover.groupConfidence}/100)` : ""}.`
            : " No confident sub-group match."
        }`
      : null;

    return NextResponse.json({
      item: withWeeklyOutreachClientMetadata(updated),
      warning:
        outlookWarning ??
        takeoverNote ??
        (threadMatch.confidence === "domain" ? null : threadMatch.reason || null),
      replySubject,
      replyConfidence: threadMatch.confidence,
      replyReason: threadMatch.reason || null,
      contextSource,
      takeover: metadata.takeover,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not prepare reconnect";
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
