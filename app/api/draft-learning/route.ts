import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { decideRule, getLearningSettings, listLearnedRules, runDraftLearning, saveLearningSettings } from "@/lib/draft-learning";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Learning from Seb's edits. GET: rules, switch, emails captured this week.
 * POST { action: "run" } | { action: "decide", id, decision: accept|reject|remove } | { action: "settings", paused }. Admin only.
 */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [rules, settings, captured] = await Promise.all([
    listLearnedRules(),
    getLearningSettings(),
    getSupabaseAdmin().from("draft_edits").select("source", { count: "exact", head: true }).gte("sent_at", since),
  ]);
  return NextResponse.json({ rules, settings, capturedThisWeek: captured.error ? null : captured.count ?? 0 });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; id?: string; decision?: string; paused?: boolean };
  try {
    if (body.action === "run") return NextResponse.json({ run: await runDraftLearning(7), rules: await listLearnedRules() });
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
