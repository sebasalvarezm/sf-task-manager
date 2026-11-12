import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { countIndexed, getReplySearchSettings, requestReplyIndex, saveReplySearchSettings } from "@/lib/reply-search";

export const dynamic = "force-dynamic";

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
      await requestReplyIndex(365);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "settings") return NextResponse.json({ settings: await saveReplySearchSettings(body.paused === true) });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Something went wrong" }, { status: 500 });
  }
}
