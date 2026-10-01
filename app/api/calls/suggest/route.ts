import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { suggestForRow } from "@/lib/call-suggest-run";
import { isSalesforceId } from "@/lib/sf-query";

export const maxDuration = 60;

/**
 * Suggested commentary, follow-up and type for one Call Logger row, from its
 * Granola note (or hand-pasted notes when it has none). Nothing is logged to
 * Salesforce here; the page shows the result as a suggestion.
 */
export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as {
    eventId?: string;
    meetingTitle?: string;
    meetingDate?: string;
    accountId?: string;
    accountName?: string;
    notes?: string;
    force?: boolean;
  };
  if (!body.eventId || typeof body.eventId !== "string") {
    return NextResponse.json({ error: "Missing meeting" }, { status: 400 });
  }
  if (!body.meetingDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.meetingDate)) {
    return NextResponse.json({ error: "Missing meeting date" }, { status: 400 });
  }
  try {
    const suggestion = await suggestForRow({
      eventId: body.eventId,
      meetingTitle: body.meetingTitle ?? "",
      meetingDate: body.meetingDate,
      accountId: isSalesforceId(body.accountId) ? body.accountId : null,
      accountName: body.accountName ?? null,
      pastedNotes: typeof body.notes === "string" ? body.notes.slice(0, 20000) : undefined,
      force: body.force === true,
    });
    if (!suggestion) {
      return NextResponse.json({ error: "No Granola note or pasted notes for this meeting yet" }, { status: 404 });
    }
    return NextResponse.json({ suggestion });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't write a suggestion" },
      { status: 503 },
    );
  }
}
