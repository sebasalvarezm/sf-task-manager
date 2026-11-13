import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { countIndexed, getReplySearchSettings, indexSentReplies, indexStopReason, saveReplySearchSettings } from "@/lib/reply-search";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Reply search. GET: switch, how many replies are indexed, whether the key is set. POST { action: "index" } or { action: "settings", paused }. Admin only. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [settings, indexed] = await Promise.all([getReplySearchSettings(), countIndexed()]);
  return NextResponse.json({ settings, indexed, tableReady: indexed !== null, keySet: Boolean(process.env.VOYAGE_API_KEY?.trim()) });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; paused?: boolean };
  try {
    if (body.action === "index") {
      // Runs here, not in the background, so the page can say what happened.
      const summary = await indexSentReplies(365);
      return NextResponse.json({ summary, reason: indexStopReason(summary.stoppedBy), indexed: await countIndexed() });
    }
    if (body.action === "settings") return NextResponse.json({ settings: await saveReplySearchSettings(body.paused === true) });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong";
    const plain =
      message === "MS_NOT_CONNECTED" ? "Outlook isn't connected." :
      message === "OUTLOOK_RECONNECT_REQUIRED" ? "Outlook needs to be reconnected (Weekly Outreach, Connect Outlook)." :
      indexStopReason(message) ?? message;
    return NextResponse.json({ error: plain }, { status: 500 });
  }
}
