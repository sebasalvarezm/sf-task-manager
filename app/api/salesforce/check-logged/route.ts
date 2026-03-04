import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { findExistingCallTasks } from "@/lib/salesforce-calls";

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId");
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!accountId || !start || !end) {
    return NextResponse.json(
      { error: "Missing accountId, start, or end" },
      { status: 400 }
    );
  }

  try {
    const loggedIds = await findExistingCallTasks([accountId], start, end);
    return NextResponse.json({ alreadyLogged: loggedIds.has(accountId) });
  } catch {
    return NextResponse.json({ alreadyLogged: false });
  }
}
