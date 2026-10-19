import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { draftInboxReply } from "@/lib/inbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { messageId, nextTouchDate?, mode? } writes Seb's reply for one inbox row. mode "template" = the fixed positive structure. */
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as { messageId?: string; nextTouchDate?: string | null; mode?: "natural" | "template" };
    if (!body.messageId) return NextResponse.json({ error: "Missing message" }, { status: 400 });
    const result = await draftInboxReply(body.messageId, body.nextTouchDate, body.mode === "template" ? "template" : "natural");
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    const status = message === "MS_NOT_CONNECTED" || message === "OUTLOOK_RECONNECT_REQUIRED" ? 409 : 500;
    return NextResponse.json({ error: message === "MS_NOT_CONNECTED" ? "Outlook isn't connected." : message }, { status });
  }
}
