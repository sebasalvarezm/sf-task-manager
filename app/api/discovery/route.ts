import { NextRequest, NextResponse } from "next/server";
import { isAdmin, isAuthenticated } from "@/lib/auth";
import { friendlyConnectionError, isConnectionError } from "@/lib/connection-errors";
import { inngest } from "@/lib/inngest/client";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  discoveryWeek,
  getDiscoverySettings,
  listDiscoveryCandidates,
  listTheses,
  monthSpend,
  pdlCreditsThisMonth,
  pushDiscovery,
  pushesThisWeek,
  reopenDiscovery,
  saveDiscoverySettings,
  skipDiscovery,
  updateThesis,
  weekUsage,
} from "@/lib/discovery";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (/weekly_outreach_source_check/.test(message)) {
    return NextResponse.json({ error: "Weekly Outreach does not accept the 'discovery' source yet. Run supabase/2026-11-discovery.sql in the Supabase SQL editor once." }, { status: 500 });
  }
  return NextResponse.json({ error: friendlyConnectionError(message) }, { status: isConnectionError(message) ? 409 : 500 });
}

/** GET: candidates, theses, settings and this week's usage, for the Outreach view and the Discovery page. */
export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const week = discoveryWeek();
    const [items, theses, settings, usage, pushed, month, credits, last] = await Promise.all([
      listDiscoveryCandidates(),
      listTheses(),
      getDiscoverySettings(),
      weekUsage(week),
      pushesThisWeek(),
      monthSpend(),
      pdlCreditsThisMonth(),
      getSupabaseAdmin().from("app_settings").select("value").eq("key", "discovery_last_run").maybeSingle().then((r) => r.data?.value ?? null),
    ]);
    return NextResponse.json({
      items,
      theses,
      settings,
      week,
      usage,
      pushed,
      month,
      pdlCredits: credits,
      lastRun: last,
      keys: { parallel: !!process.env.PARALLEL_API_KEY?.trim(), pdl: !!process.env.PDL_API_KEY?.trim() },
    });
  } catch (err) {
    return fail(err);
  }
}

/**
 * POST { action, ... }
 *   push { id } · skip { id, reason? } · reopen { id }      review (any signed-in user)
 *   settings { settings } · thesis { id, thesis }             config (admin)
 *   preview { thesisId }                                      $0.10, admin
 *   dry_run { thesisId, matchLimit? }                         one thesis, 5 matches by default, admin
 */
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    switch (body.action) {
      case "push": {
        const r = await pushDiscovery(id);
        return NextResponse.json({ item: r.candidate, weekly: r.weekly, note: r.note });
      }
      case "skip":
        return NextResponse.json({ item: await skipDiscovery(id, typeof body.reason === "string" ? body.reason : null) });
      case "reopen":
        return NextResponse.json({ item: await reopenDiscovery(id) });
    }
    if (!(await isAdmin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
    switch (body.action) {
      case "settings":
        return NextResponse.json({ settings: await saveDiscoverySettings(body.settings) });
      case "thesis":
        return NextResponse.json({ thesis: await updateThesis(id, (body.thesis ?? {}) as Record<string, unknown>) });
      case "preview": {
        if (!process.env.PARALLEL_API_KEY?.trim()) return NextResponse.json({ error: "Add PARALLEL_API_KEY in Vercel first." }, { status: 400 });
        await inngest.send({ name: "discovery/preview", data: { thesisId: String(body.thesisId ?? "") } });
        return NextResponse.json({ started: true });
      }
      case "dry_run": {
        if (!process.env.PARALLEL_API_KEY?.trim()) return NextResponse.json({ error: "Add PARALLEL_API_KEY in Vercel first." }, { status: 400 });
        const matchLimit = Math.max(5, Math.min(25, Number(body.matchLimit) || 5));
        await inngest.send({ name: "discovery/run", data: { thesisId: String(body.thesisId ?? ""), matchLimit, manual: true } });
        return NextResponse.json({ started: true, matchLimit });
      }
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
