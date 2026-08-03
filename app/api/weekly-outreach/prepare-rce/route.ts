import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { searchMailboxMessages } from "@/lib/microsoft";
import { fetchRecentAccountActivity } from "@/lib/salesforce-prep";
import type { WeeklyOutreachItem } from "@/lib/weekly-outreach";

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
  const client = getAnthropicClient();
  if (!client) return NextResponse.json({ error: "AI service not configured" }, { status: 503 });

  try {
    const domain = domainFromWebsite(item.website);
    const [relationshipEmails, personalAngleEmails, sfActivity] = await Promise.all([
      searchMailboxMessages(domain ?? item.account_name, 25).catch(() => []),
      searchMailboxMessages("100th birthday", 8).catch(() => []),
      fetchRecentAccountActivity(item.sf_account_id).catch(() => []),
    ]);
    const relationshipText = relationshipEmails.map((m) =>
      `${m.sentDateTime} | ${m.fromEmail} -> ${m.toEmails.join(", ")} | ${m.subject}\n${m.bodyText.slice(0, 1800)}`,
    ).join("\n\n");
    const personalAngleText = personalAngleEmails.map((m) => `${m.subject}\n${m.bodyText.slice(0, 1200)}`).join("\n\n");
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      messages: [{ role: "user", content: `Draft a reconnect email for an M&A professional. Match the user's actual sent-email voice in the evidence: concise, natural, specific, and human. Avoid AI jargon, generic praise, hype, em dashes, and invented history. Do not include a greeting or signature. Do not claim the recipient said something unless the thread supports it.

Company: ${item.account_name}
Salesforce activity:
${sfActivity.join("\n") || "No Salesforce activity available"}

Relevant Outlook exchanges (received and sent):
${relationshipText || "No relevant Outlook thread found"}

Optional recent personal-angle examples from the user's sent mail. Reuse only if the evidence makes the wording clear and it fits naturally; otherwise ignore it:
${personalAngleText || "No personal-angle example found"}

Return ONLY JSON:
{
  "contextSummary": "2-4 sentences: last meaningful interaction, concrete detail, objection/promise, and why reconnect now",
  "draft": "subject line on first line, blank line, then a short reconnect email body"
}` }],
    });
    const text = message.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("\n");
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as { contextSummary: string; draft: string };
    const { data: updated, error: updateError } = await supabase
      .from("weekly_outreach")
      .update({ context_summary: parsed.contextSummary, draft: parsed.draft, status: "draft_ready" })
      .eq("id", id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json({ item: updated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not prepare reconnect" }, { status: 500 });
  }
}
