import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isAuthenticated } from "@/lib/auth";

// GET /api/triage?date=2026-03-24
// Returns all triage emails for a given date
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const date =
    searchParams.get("date") || new Date().toISOString().split("T")[0];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_triage")
    .select("*")
    .eq("triage_date", date)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ emails: data, date });
}

// POST /api/triage
// Bulk-insert triage results (called by the Cowork scheduled task)
export async function POST(request: NextRequest) {
  // Auth: Accept either session cookie OR a secret API key header
  // (The Cowork scheduled task won't have a browser session, so it uses the API key)
  const apiKey = request.headers.get("x-triage-api-key");
  const validApiKey = process.env.TRIAGE_API_KEY;

  const isSessionAuth = await isAuthenticated();
  const isApiKeyAuth = validApiKey && apiKey === validApiKey;

  if (!isSessionAuth && !isApiKeyAuth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { emails, date } = body;

  if (!emails || !Array.isArray(emails) || !date) {
    return NextResponse.json(
      { error: "Missing emails array or date" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();

  // Upsert to handle re-runs on the same day
  const rows = emails.map((em: Record<string, unknown>) => ({
    triage_date: date,
    email_id: em.email_id || null,
    sender_name: em.sender_name,
    sender_email: em.sender_email || null,
    subject: em.subject,
    priority: em.priority,
    context: em.context || null,
    flag_note: em.flag_note || null,
    is_flagged: em.is_flagged || false,
    thread: em.thread || [],
    draft: em.draft || null,
    review_status: "pending",
  }));

  // Delete existing triage for this date before inserting (handles re-runs)
  await supabase
    .from("email_triage")
    .delete()
    .eq("triage_date", date);

  const { data, error } = await supabase
    .from("email_triage")
    .insert(rows)
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ inserted: data?.length || 0 });
}
