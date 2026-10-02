import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { listInMailQueue, refreshInMailQueue, updateInMailRow, type InMailStatus } from "@/lib/inmail-queue";

export const maxDuration = 120;

function friendly(message: string): { error: string; status: number } {
  if (message === "NOT_CONNECTED") return { error: "Salesforce isn't connected.", status: 409 };
  if (/inmail_queue/.test(message) && /does not exist|relation/.test(message)) {
    return { error: "The inmail_queue table is missing. Run supabase/2026-10-inmail-queue.sql in the Supabase SQL editor once.", status: 500 };
  }
  return { error: message, status: 500 };
}

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ items: await listInMailQueue() });
  } catch (err) {
    const f = friendly(err instanceof Error ? err.message : "Unexpected error");
    return NextResponse.json({ error: f.error }, { status: f.status });
  }
}

/** POST { days? } refreshes the queue from Salesforce. */
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { days?: number };
    const summary = await refreshInMailQueue(typeof body.days === "number" ? body.days : 7);
    return NextResponse.json({ summary, items: await listInMailQueue() });
  } catch (err) {
    const f = friendly(err instanceof Error ? err.message : "Unexpected error");
    return NextResponse.json({ error: f.error }, { status: f.status });
  }
}

/** PATCH { whoId, status?, subject?, initialMessage?, followupMessage?, linkedinUrl?, firstName? } */
export async function PATCH(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      whoId?: string;
      status?: InMailStatus;
      subject?: string;
      initialMessage?: string;
      followupMessage?: string;
      linkedinUrl?: string | null;
      firstName?: string;
    };
    if (!body.whoId) return NextResponse.json({ error: "Missing contact" }, { status: 400 });
    const allowed: InMailStatus[] = ["pending", "generated", "needs_review", "sent", "followup_sent", "dismissed"];
    if (body.status && !allowed.includes(body.status)) {
      return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    }
    const item = await updateInMailRow(body.whoId, {
      ...(body.status ? { status: body.status } : {}),
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.initialMessage !== undefined ? { initial_message: body.initialMessage } : {}),
      ...(body.followupMessage !== undefined ? { followup_message: body.followupMessage } : {}),
      ...(body.linkedinUrl !== undefined ? { linkedin_url: body.linkedinUrl } : {}),
      ...(body.firstName !== undefined ? { first_name: body.firstName } : {}),
    });
    return NextResponse.json({ item });
  } catch (err) {
    const f = friendly(err instanceof Error ? err.message : "Unexpected error");
    return NextResponse.json({ error: f.error }, { status: f.status });
  }
}
