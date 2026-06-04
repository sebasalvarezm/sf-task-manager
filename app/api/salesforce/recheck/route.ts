import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { checkRecontact, RECONTACT_THRESHOLD_DAYS } from "@/lib/salesforce-recheck";

// Bulk last-activity lookup. Body: { names: string[] }.
// Returns { rows, thresholdDays }.
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body as { names?: unknown }).names;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { error: "Expected a 'names' array" },
      { status: 400 }
    );
  }

  // Trim, drop blanks, de-dupe (case-insensitive) while preserving first-seen order.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  if (names.length === 0) {
    return NextResponse.json(
      { error: "Paste at least one company name" },
      { status: 400 }
    );
  }

  if (names.length > 200) {
    return NextResponse.json(
      { error: "Too many names — please check 200 or fewer at a time" },
      { status: 400 }
    );
  }

  try {
    const rows = await checkRecontact(names);
    return NextResponse.json({ rows, thresholdDays: RECONTACT_THRESHOLD_DAYS });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    const status = message === "NOT_CONNECTED" ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
