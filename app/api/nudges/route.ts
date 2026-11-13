import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { classifyAccounts, prepareNudge, sendNudge } from "@/lib/nudges";
import { recordDraft, recordFinal, refreshLearnedRules } from "@/lib/draft-learning";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST { action: "classify", accountIds }            → { nudges: { [accountId]: { lastInAt, topic } } }
 * POST { action: "prepare", accountId, accountName, website, topic } → prepared nudge
 * POST { action: "send", replyToMessageId, sender, body, taskId, accountId, subject, days }
 */
export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.action === "classify") {
      const ids = Array.isArray(body.accountIds) ? (body.accountIds as string[]) : [];
      return NextResponse.json({ nudges: await classifyAccounts(ids) });
    }
    if (body.action === "prepare") {
      await refreshLearnedRules();
      const prepared = await prepareNudge({
          accountId: String(body.accountId ?? ""),
          accountName: String(body.accountName ?? ""),
          website: typeof body.website === "string" ? body.website : null,
          topic: String(body.topic ?? "follow-up"),
          via: body.via === "sent" || body.via === "call" || body.via === "email" ? body.via : undefined,
        });
      await recordDraft("nudge", String(body.accountId ?? ""), prepared.body, String(body.accountName ?? "") || null);
      return NextResponse.json(prepared);
    }
    if (body.action === "send") {
      const days = typeof body.days === "number" && body.days > 0 ? Math.round(body.days) : null;
      const sent = await sendNudge({
          replyToMessageId: typeof body.replyToMessageId === "string" && body.replyToMessageId ? body.replyToMessageId : null,
          emailSubject: typeof body.emailSubject === "string" ? body.emailSubject : undefined,
          sender: body.sender as { name: string | null; email: string },
          body: String(body.body ?? ""),
          taskId: String(body.taskId ?? ""),
          accountId: String(body.accountId ?? ""),
          subject: String(body.subject ?? "RCE"),
          days,
        });
      await recordFinal("nudge", String(body.accountId ?? ""), String(body.body ?? ""));
      return NextResponse.json(sent);
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong";
    if (message === "MS_NOT_CONNECTED") return NextResponse.json({ error: "Outlook isn't connected." }, { status: 409 });
    if (message === "OUTLOOK_RECONNECT_REQUIRED") return NextResponse.json({ error: "Outlook needs to be reconnected." }, { status: 409 });
    if (message === "NOT_CONNECTED") return NextResponse.json({ error: "Salesforce isn't connected." }, { status: 409 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
