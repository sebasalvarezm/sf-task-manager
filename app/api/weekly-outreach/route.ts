import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  addAccountToWeeklyOutreach,
  addWeeklyOutreachBatch,
  currentWeekStart,
  parseManualWeeklyEntry,
  resolveWeeklyAccountByName,
  upsertWeeklyOutreachItem,
  withWeeklyOutreachClientMetadata,
  type WeeklyOutreachSource,
  type WeeklyOutreachStatus,
  type WeeklyOutreachType,
} from "@/lib/weekly-outreach";

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const weekStart = new URL(request.url).searchParams.get("weekStart") ?? currentWeekStart();
  const { data, error } = await getSupabaseAdmin()
    .from("weekly_outreach")
    .select("*")
    .eq("week_start", weekStart)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    items: (data ?? []).map((item) => withWeeklyOutreachClientMetadata(item)),
    weekStart,
  });
}

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as {
      entry?: string;
      weekStart?: string;
      outreachType?: WeeklyOutreachType;
      accountId?: string;
      source?: WeeklyOutreachSource;
      sourceReference?: string;
      rceDays?: number;
      entries?: Array<{ outreachType: WeeklyOutreachType; accountName: string }>;
    };

    if (body.entries) {
      if (body.entries.length === 0 || body.entries.length > 50) {
        return NextResponse.json(
          { error: "Paste between 1 and 50 companies at a time." },
          { status: 400 },
        );
      }
      const results = await addWeeklyOutreachBatch({
        entries: body.entries,
        weekStart: body.weekStart,
        source: "manual",
      });
      return NextResponse.json({
        results: results.map((result) => ({
          ...result,
          item: result.item ? withWeeklyOutreachClientMetadata(result.item) : undefined,
        })),
      });
    }

    if (body.entry) {
      const parsed = parseManualWeeklyEntry(body.entry);
      if (!parsed) {
        return NextResponse.json(
          { error: 'Use "E1 Company Name" or "RCE Company Name".' },
          { status: 400 },
        );
      }
      const resolved = await resolveWeeklyAccountByName(parsed.accountName);
      if (!resolved.account) {
        return NextResponse.json(
          {
            error:
              resolved.candidates.length > 1
                ? "More than one Salesforce account matched. Enter the full account name exactly as stored in Salesforce."
                : "No Salesforce account matched that name.",
            candidates: resolved.candidates.map((a) => a.accountName),
          },
          { status: resolved.candidates.length > 1 ? 409 : 404 },
        );
      }
      const item = await upsertWeeklyOutreachItem({
        weekStart: body.weekStart,
        outreachType: parsed.outreachType,
        account: resolved.account,
        source: "manual",
      });
      return NextResponse.json({ item: withWeeklyOutreachClientMetadata(item) });
    }

    if (!body.accountId || !body.outreachType) {
      return NextResponse.json({ error: "Missing account or outreach type" }, { status: 400 });
    }
    const item = await addAccountToWeeklyOutreach({
      accountId: body.accountId,
      outreachType: body.outreachType,
      weekStart: body.weekStart,
      source: body.source ?? "manual",
      sourceReference: body.sourceReference,
      rceDays: body.rceDays,
    });
    return NextResponse.json({ item: withWeeklyOutreachClientMetadata(item) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    ids?: string[];
    id?: string;
    status?: WeeklyOutreachStatus;
    notes?: string | null;
    draft?: string | null;
    contextSummary?: string | null;
    sourcingJobId?: string | null;
    outreachType?: WeeklyOutreachType;
    accountName?: string;
    website?: string | null;
    industry?: string | null;
    country?: string | null;
    city?: string | null;
    tier?: string | null;
    groupName?: string | null;
  };
  const ids = body.ids ?? (body.id ? [body.id] : []);
  if (ids.length === 0) return NextResponse.json({ error: "Missing row id" }, { status: 400 });
  const updates: Record<string, unknown> = {};
  if (body.status !== undefined) updates.status = body.status;
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.draft !== undefined) updates.draft = body.draft;
  if (body.contextSummary !== undefined) updates.context_summary = body.contextSummary;
  if (body.sourcingJobId !== undefined) updates.sourcing_job_id = body.sourcingJobId;
  if (body.outreachType !== undefined) updates.outreach_type = body.outreachType;
  if (body.accountName !== undefined) {
    const accountName = body.accountName.trim();
    if (!accountName) {
      return NextResponse.json({ error: "Company name cannot be empty" }, { status: 400 });
    }
    updates.account_name = accountName;
  }
  if (body.website !== undefined) updates.website = body.website?.trim() || null;
  if (body.industry !== undefined) updates.industry = body.industry?.trim() || null;
  if (body.country !== undefined) updates.country = body.country?.trim() || null;
  if (body.city !== undefined) updates.city = body.city?.trim() || null;
  if (body.tier !== undefined) updates.tier = body.tier?.trim() || null;
  if (body.groupName !== undefined) updates.group_name = body.groupName?.trim() || null;
  const { data, error } = await getSupabaseAdmin()
    .from("weekly_outreach")
    .update(updates)
    .in("id", ids)
    .select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    items: (data ?? []).map((item) => withWeeklyOutreachClientMetadata(item)),
  });
}

export async function DELETE(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing row id" }, { status: 400 });
  const { error } = await getSupabaseAdmin().from("weekly_outreach").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
