import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { describeResponseFields } from "@/lib/inbox-salesforce";

export const dynamic = "force-dynamic";

/** GET: which Account fields the Inbox will write (for checking the setup). */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await describeResponseFields(true));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message === "NOT_CONNECTED" ? "Salesforce isn't connected." : message }, { status: 500 });
  }
}
