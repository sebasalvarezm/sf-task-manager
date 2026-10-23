import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { classifyAccounts, prepareNudge, sendNudge } from "@/lib/nudges";

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
      return NextResponse.json(
        await prepareNudge({
          accountId: String(body.accountId ?? ""),
          accountName: String(body.accountName ?? ""),
          website: typeof body.website === "string" ? body.website : null,
          topic: String(body.topic ?? "follow-up"),
        }),
      );
    }
    if (body.action === "send") {
      const days = typeof body.days === "number" && body.days > 0 ? Math.round(body.days) : null;
      return NextResponse.json(
        await sendNudge({
          replyToMessageId: String(body.replyToMessageId ?? ""),
          sender: body.sender as { name: string | null; email: string },
          body: String(body.body ?? ""),
          taskId: String(body.taskId ?? ""),
          accountId: String(body.accountId ?? ""),
          subject: String(body.subject ?? "RCE"),
          days,
        }),
      );
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
