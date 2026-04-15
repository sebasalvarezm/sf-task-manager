import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getOutreachValidCredentials } from "@/lib/outreach";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const credentials = await getOutreachValidCredentials();
  return NextResponse.json({ connected: credentials !== null });
}

export async function DELETE() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  await supabase.from("outreach_credentials").delete().eq("id", "default");

  return NextResponse.json({ disconnected: true });
}
