import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  fetchRecentEmails,
  fetchEmailThread,
  OutlookEmail,
} from "@/lib/microsoft";
import Anthropic from "@anthropic-ai/sdk";

// POST /api/triage/scan
// Scans recent Outlook emails, categorizes with AI, writes to triage table
export async function POST() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. Fetch recent emails (last 24 hours)
    const emails = await fetchRecentEmails(24);

    if (emails.length === 0) {
      return NextResponse.json({ message: "No emails found", count: 0 });
    }

    // Filter out internal Valstone/Valsoft emails and calendar/automated noise
    const externalEmails = emails.filter((e) => {
      const sender = e.from.email.toLowerCase();
      if (sender.includes("@valstonecorp.com")) return false;
      if (sender.includes("@valsoftcorp.com")) return false;
      if (sender.includes("noreply") || sender.includes("no-reply")) return false;
      if (sender.includes("mailer-daemon")) return false;
      if (sender.includes("notifications@")) return false;
      return true;
    });

    if (externalEmails.length === 0) {
      return NextResponse.json({
        message: "No external emails to triage",
        count: 0,
      });
    }

    // 2. Group by conversation and fetch threads for top emails
    const seen = new Set<string>();
    const uniqueEmails: OutlookEmail[] = [];
    for (const email of externalEmails) {
      if (!seen.has(email.conversationId)) {
        seen.add(email.conversationId);
        uniqueEmails.push(email);
      }
    }

    // Limit to 25 conversations to keep API costs manageable
    const toProcess = uniqueEmails.slice(0, 25);

    // Fetch threads for each conversation
    const emailsWithThreads = await Promise.all(
      toProcess.map(async (email) => {
        const thread = await fetchEmailThread(email.conversationId);
        return { email, thread };
      })
    );

    // 3. Call Claude to categorize and draft replies
    const anthropic = new Anthropic();

    const emailSummaries = emailsWithThreads.map(({ email, thread }, i) => {
      const threadText = thread
        .map(
          (msg) =>
            `[${msg.from.name} <${msg.from.email}> — ${msg.receivedDateTime}]\n${msg.bodyText.slice(0, 500)}`
        )
        .join("\n---\n");

      return `EMAIL #${i + 1}:
Subject: ${email.subject}
From: ${email.from.name} <${email.from.email}>
Received: ${email.receivedDateTime}
Thread (${thread.length} messages):
${threadText}
`;
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are an email triage assistant for Sebastian, an M&A professional at Valstone (a software company acquirer).

Categorize each email and draft a reply where appropriate.

PRIORITY LEVELS:
- p1: Urgent — needs reply today (active deals, time-sensitive requests, executives, partners)
- p2: Important — needs reply within 2 days (follow-ups, scheduling, business requests)
- p3: Low — informational, newsletters, can wait or ignore

RULES:
- For p1 and p2 emails, draft a professional reply as Sebastian
- For p3, only draft a reply if one is clearly needed
- If an email is flagged for personal attention (unusual, sensitive, or unclear), set is_flagged to true and write a flag_note explaining why
- Keep drafts concise and professional
- If the email is a cold outreach/sales pitch to Sebastian, set priority to p3 and don't draft a reply

Return a JSON array (no markdown fences) with this structure for each email:
[
  {
    "index": 0,
    "priority": "p1",
    "context": "One-line summary of why this matters",
    "is_flagged": false,
    "flag_note": null,
    "draft": "The draft reply text, or null if no reply needed"
  }
]

Here are the emails to triage:

${emailSummaries.join("\n==========\n")}`,
        },
      ],
    });

    // Parse AI response
    const aiText =
      response.content[0].type === "text" ? response.content[0].text : "";

    let triageResults: Array<{
      index: number;
      priority: string;
      context: string;
      is_flagged: boolean;
      flag_note: string | null;
      draft: string | null;
    }>;

    try {
      // Try direct parse first, then extract from markdown fences
      const cleaned = aiText
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
      triageResults = JSON.parse(cleaned);
    } catch {
      // Fallback: find JSON array in response
      const match = aiText.match(/\[[\s\S]*\]/);
      if (match) {
        triageResults = JSON.parse(match[0]);
      } else {
        return NextResponse.json(
          { error: "Failed to parse AI categorization" },
          { status: 500 }
        );
      }
    }

    // 4. Write to Supabase
    const today = new Date().toISOString().split("T")[0];
    const supabase = getSupabaseAdmin();

    const rows = triageResults.map((result, i) => {
      // Use the AI's index if valid, otherwise fall back to array position
      const idx =
        result.index != null && emailsWithThreads[result.index]
          ? result.index
          : i;
      const entry = emailsWithThreads[idx];
      if (!entry) return null;
      const { email, thread } = entry;
      return {
        triage_date: today,
        email_id: email.id,
        sender_name: email.from.name || email.from.email,
        sender_email: email.from.email,
        subject: email.subject,
        priority: result.priority,
        context: result.context,
        flag_note: result.flag_note,
        is_flagged: result.is_flagged || false,
        thread: thread.map((msg) => ({
          from: `${msg.from.name} <${msg.from.email}>`,
          date: msg.receivedDateTime,
          body: msg.bodyText.slice(0, 1000),
        })),
        draft: result.draft,
        review_status: "pending",
      };
    });

    const validRows = rows.filter(Boolean);

    const { data, error } = await supabase
      .from("email_triage")
      .upsert(validRows, { onConflict: "triage_date,email_id" })
      .select();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      message: `Triaged ${data?.length ?? 0} emails`,
      count: data?.length ?? 0,
      breakdown: {
        p1: triageResults.filter((r) => r.priority === "p1").length,
        p2: triageResults.filter((r) => r.priority === "p2").length,
        p3: triageResults.filter((r) => r.priority === "p3").length,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Scan failed";

    if (message === "MS_NOT_CONNECTED") {
      return NextResponse.json(
        { error: "Outlook not connected. Please reconnect from the homepage." },
        { status: 401 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
