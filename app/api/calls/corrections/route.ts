import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { saveCorrections, type CorrectionInput } from "@/lib/call-corrections";

/**
 * Saves what was suggested and what you logged instead, for rows where you
 * changed a suggestion. Called by the Call Logger when you press Log. A
 * failure here never blocks logging.
 */
export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { corrections?: unknown };
  const list = Array.isArray(body.corrections) ? body.corrections.slice(0, 200) : [];
  const clean: CorrectionInput[] = [];
  for (const raw of list) {
    const c = raw as Partial<CorrectionInput>;
    if (!c || typeof c.eventId !== "string" || !c.suggested || !c.final) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : null);
    clean.push({
      eventId: c.eventId.slice(0, 500),
      granolaNoteId: str(c.granolaNoteId),
      accountName: str(c.accountName),
      meetingDate: str(c.meetingDate),
      suggested: {
        commentary: str(c.suggested.commentary),
        callType: str(c.suggested.callType),
        followUpDays: num(c.suggested.followUpDays),
      },
      final: {
        commentary: str(c.final.commentary) ?? "",
        callType: str(c.final.callType) ?? "",
        followUpDays: num(c.final.followUpDays),
      },
    });
  }
  try {
    const saved = await saveCorrections(clean);
    return NextResponse.json({ saved });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't save corrections" }, { status: 500 });
  }
}
