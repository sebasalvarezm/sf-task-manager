import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSuggestionsForRange } from "@/lib/call-suggestion-store";

export const dynamic = "force-dynamic";

/** Suggestions already written for this week's rows. */
export async function GET(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  try {
    const suggestions = await getSuggestionsForRange(
      url.searchParams.get("start") ?? "",
      url.searchParams.get("end") ?? "",
    );
    return NextResponse.json({ suggestions });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't load suggestions" },
      { status: 500 },
    );
  }
}
