import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { listSequences, listMailboxes } from "@/lib/outreach";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [sequences, mailboxes] = await Promise.all([
      listSequences(),
      listMailboxes(),
    ]);
    return NextResponse.json({
      sequences: sequences.filter((s) => s.enabled),
      mailboxes,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
