import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { GranolaError, getGranolaTranscript, isGranolaNoteId, transcriptToText } from "@/lib/granola";
import { getStoredGranolaNote } from "@/lib/granola-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The transcript behind the "Show transcript" toggle. Read from Granola on
 * demand and never stored. Only for notes already matched to a Call Logger
 * meeting, so this can't be used to read any other Granola note.
 */
export async function GET(_request: Request, context: { params: Promise<{ noteId: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { noteId } = await context.params;
  if (!isGranolaNoteId(noteId)) return NextResponse.json({ error: "Invalid note id" }, { status: 400 });
  try {
    const stored = await getStoredGranolaNote(noteId);
    if (!stored) {
      return NextResponse.json({ error: "This note isn't linked to a Call Logger meeting." }, { status: 404 });
    }
    const transcript = transcriptToText(await getGranolaTranscript(noteId));
    return NextResponse.json(
      { transcript },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    const message =
      err instanceof GranolaError || err instanceof Error ? err.message : "Couldn't load the transcript";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
