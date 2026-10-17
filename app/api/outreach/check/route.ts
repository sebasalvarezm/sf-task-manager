import { NextRequest, NextResponse } from "next/server";
import { friendlyConnectionError, isConnectionError } from "@/lib/connection-errors";
import { isAuthenticated } from "@/lib/auth";
import { checkAccountNames } from "@/lib/outreach-candidates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { names: string[] } applies the rules of engagement to a pasted list of company names. */
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { names?: unknown };
    const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string").map((n) => n.trim()).filter(Boolean) : [];
    const seen = new Set<string>();
    const unique = names.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length === 0 || unique.length > 200) return NextResponse.json({ error: "Paste between 1 and 200 company names, one per line." }, { status: 400 });
    return NextResponse.json({ rows: await checkAccountNames(unique) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: friendlyConnectionError(message) }, { status: isConnectionError(message) ? 409 : 500 });
  }
}
