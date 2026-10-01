import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getGranolaNotesForRange } from "@/lib/granola-store";

export const dynamic = "force-dynamic";

/**
 * Granola summaries already matched to this week's Call Logger rows.
 * Only stored (matched) notes come back; nothing is fetched from Granola here.
 */
export async function GET(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  try {
    const notes = await getGranolaNotesForRange(start, end);
    return NextResponse.json({
      notes: notes.map((n) => ({
        eventId: n.event_id,
        noteId: n.granola_note_id,
        title: n.title,
        summary: n.summary,
        webUrl: n.web_url,
        matchedBy: n.matched_by,
        syncedAt: n.synced_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't load Granola notes" },
      { status: 500 },
    );
  }
}
