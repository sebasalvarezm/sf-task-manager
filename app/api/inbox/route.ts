import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { listInbox, refreshInbox, reclassifyInboxRow, updateInboxRow, type InboxStatus } from "@/lib/inbox";

export const dynamic = "force-dynamic";
// Refresh reads every candidate thread and classifies it inline.
export const maxDuration = 120;

function friendly(message: string): { error: string; status: number } {
  if (message === "MS_NOT_CONNECTED") return { error: "Outlook isn't connected. Connect it from Weekly Outreach first.", status: 409 };
  if (message === "OUTLOOK_RECONNECT_REQUIRED") return { error: "Outlook needs to be reconnected (permission expired).", status: 409 };
  if (message === "NOT_CONNECTED") return { error: "Salesforce isn't connected.", status: 409 };
  if (/inbox_replies/.test(message) && /does not exist|relation|schema cache/.test(message)) {
    return { error: "The inbox_replies table is missing. Run supabase/2026-10-inbox-replies.sql in the Supabase SQL editor once.", status: 500 };
  }
  return { error: message, status: 500 };
}

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ items: await listInbox() });
  } catch (err) {
    const f = friendly(err instanceof Error ? err.message : "Unexpected error");
    return NextResponse.json({ error: f.error }, { status: f.status });
  }
}

/** POST { days? } pulls new unread replies from Outlook and classifies them. */
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { days?: number };
    const days = typeof body.days === "number" && body.days > 0 && body.days <= 60 ? body.days : 14;
    const summary = await refreshInbox(days);
    return NextResponse.json({ summary, items: await listInbox() });
  } catch (err) {
    const f = friendly(err instanceof Error ? err.message : "Unexpected error");
    return NextResponse.json({ error: f.error }, { status: f.status });
  }
}

/** PATCH { messageId, status?, draftBody?, suggestedDate?, sentiment?, reclassify? } */
export async function PATCH(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      messageId?: string;
      status?: InboxStatus;
      draftBody?: string;
      suggestedDate?: string | null;
      sentiment?: "positive" | "neutral" | "negative" | "unclear";
      reclassify?: boolean;
    };
    if (!body.messageId) return NextResponse.json({ error: "Missing message" }, { status: 400 });
    if (body.reclassify) {
      return NextResponse.json({ item: await reclassifyInboxRow(body.messageId) });
    }
    const allowed: InboxStatus[] = ["new", "drafted", "sent", "skipped"];
    if (body.status && !allowed.includes(body.status)) {
      return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    }
    if (body.suggestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.suggestedDate)) {
      return NextResponse.json({ error: "Date must be YYYY-MM-DD" }, { status: 400 });
    }
    const item = await updateInboxRow(body.messageId, {
      ...(body.status ? { status: body.status } : {}),
      ...(body.draftBody !== undefined ? { draft_body: body.draftBody } : {}),
      ...(body.suggestedDate !== undefined ? { suggested_date: body.suggestedDate } : {}),
      ...(body.sentiment ? { sentiment: body.sentiment } : {}),
    });
    return NextResponse.json({ item });
  } catch (err) {
    const f = friendly(err instanceof Error ? err.message : "Unexpected error");
    return NextResponse.json({ error: f.error }, { status: f.status });
  }
}
