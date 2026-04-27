import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { markAllSeen } from "@/lib/jobs";

export async function POST() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const updated = await markAllSeen();
    return NextResponse.json({ updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
