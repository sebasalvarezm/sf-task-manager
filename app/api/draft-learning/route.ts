import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { backfillQueueEdits, decideRule, getLearningSettings, listLearnedRules, runDraftLearning, saveLearningSettings } from "@/lib/draft-learning";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Learning from Seb's edits. GET: rules, switch, emails captured this week.
 * POST { action: "run", days? (7-21) } | { action: "backfill" } | { action: "decide", id, decision: accept|reject|remove } | { action: "settings", paused }. Admin only.
 */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [rules, settings, captured] = await Promise.all([
    listLearnedRules(),
    getLearningSettings(),
    getSupabaseAdmin().from("draft_edits").select("source").gte("sent_at", since).limit(2000),
  ]);
  if (captured.error) return NextResponse.json({ rules, settings, capturedThisWeek: null, bySource: {} });
  const bySource: Record<string, number> = {};
  for (const r of (captured.data ?? []) as Array<{ source: string }>) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  const hooks = bySource.hook ?? 0;
  delete bySource.hook;
  const emails = Object.values(bySource).reduce((a, b) => a + b, 0);
  return NextResponse.json({ rules, settings, capturedThisWeek: emails, bySource, hookRejections: hooks });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; id?: string; decision?: string; paused?: boolean; days?: number };
  try {
    if (body.action === "run") {
      const days = Math.min(21, Math.max(7, Math.round(Number(body.days) || 7)));
      return NextResponse.json({ run: await runDraftLearning(days), rules: await listLearnedRules() });
    }
    // One-off: E1s that went out before the Send queue saved first drafts. Writes only to the learning table.
    if (body.action === "backfill") return NextResponse.json({ backfill: await backfillQueueEdits(21) });
    if (body.action === "decide") {
      if (!body.id || !["accept", "reject", "remove"].includes(body.decision ?? "")) return NextResponse.json({ error: "Missing rule or decision" }, { status: 400 });
      return NextResponse.json({ rules: await decideRule(body.id, body.decision as "accept" | "reject" | "remove") });
    }
    if (body.action === "settings") return NextResponse.json({ settings: await saveLearningSettings(body.paused === true) });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Something went wrong" }, { status: 500 });
  }
}
