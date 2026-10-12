import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { sendInboxReply } from "@/lib/inbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function friendly(message: string): string {
  if (message === "MS_NOT_CONNECTED") return "Outlook isn't connected. Connect it from Weekly Outreach first.";
  if (message === "OUTLOOK_RECONNECT_REQUIRED") return "Outlook needs to be reconnected (permission expired).";
  if (message === "NOT_CONNECTED") return "Salesforce isn't connected.";
  return message;
}

/** POST { messageId, body, rceDays|null, sentiment? } sends the reply and updates Salesforce. */
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      messageId?: string;
      body?: string;
      rceDays?: number | null;
      sentiment?: "positive" | "neutral" | "negative" | "unclear";
    };
    if (!body.messageId) return NextResponse.json({ error: "Missing message" }, { status: 400 });
    if (!body.body || !body.body.trim()) return NextResponse.json({ error: "The reply is empty." }, { status: 400 });
    const rceDays = typeof body.rceDays === "number" && body.rceDays > 0 ? Math.round(body.rceDays) : null;
    const result = await sendInboxReply({ messageId: body.messageId, body: body.body, rceDays, sentiment: body.sentiment });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    const status = /NOT_CONNECTED|RECONNECT/.test(message) ? 409 : 500;
    return NextResponse.json({ error: friendly(message) }, { status });
  }
}
