import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getContactNotesSettings, listContactNotes, runContactNotes, saveContactNotesSettings } from "@/lib/contact-notes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "Will contact this week" notes. GET: the list and the pause switch. POST { action: "run" } or { action: "settings", paused }. Admin only. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [items, settings] = await Promise.all([listContactNotes(), getContactNotesSettings()]);
  return NextResponse.json({ items, settings });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; paused?: boolean };
  try {
    if (body.action === "run") return NextResponse.json({ run: await runContactNotes(), items: await listContactNotes() });
    if (body.action === "settings") return NextResponse.json({ settings: await saveContactNotesSettings(body.paused === true) });
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong";
    return NextResponse.json({ error: message === "NOT_CONNECTED" ? "Salesforce isn't connected." : message }, { status: message === "NOT_CONNECTED" ? 409 : 500 });
  }
}
