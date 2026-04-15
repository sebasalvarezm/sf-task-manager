import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { buildQueue } from "@/lib/outreach-queue";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const queue = await buildQueue();
    return NextResponse.json(queue);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
