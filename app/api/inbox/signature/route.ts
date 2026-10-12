import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { importSignatureFromSentItems } from "@/lib/microsoft";
import { getStoredSignature, saveStoredSignature, textToHtml } from "@/lib/outlook-signature";

export const dynamic = "force-dynamic";

/** GET: the signature the tool appends to sent emails, if one is stored. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ signature: await getStoredSignature() });
}

/**
 * POST { action: "import" } reads it from your recent sent emails;
 * POST { text } stores a pasted plain-text signature;
 * POST { action: "clear" } removes it.
 */
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: string; text?: string };
    if (body.action === "clear") {
      await saveStoredSignature(null);
      return NextResponse.json({ signature: null });
    }
    if (body.action === "import") {
      const found = await importSignatureFromSentItems();
      if (!found) {
        return NextResponse.json({ error: "No signature found in your last 15 sent emails. Paste it instead." }, { status: 404 });
      }
      const signature = await saveStoredSignature({ ...found, source: "imported" });
      return NextResponse.json({ signature });
    }
    if (typeof body.text === "string" && body.text.trim()) {
      const text = body.text.trim();
      const signature = await saveStoredSignature({ html: textToHtml(text), text, source: "pasted" });
      return NextResponse.json({ signature });
    }
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message === "MS_NOT_CONNECTED" ? "Outlook isn't connected." : message }, { status: 500 });
  }
}
