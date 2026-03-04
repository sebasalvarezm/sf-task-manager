import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getMsValidCredentials } from "@/lib/microsoft";

// Returns whether Microsoft Outlook is currently connected.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const credentials = await getMsValidCredentials();
  return NextResponse.json({ connected: credentials !== null });
}

// Disconnect: delete the stored Microsoft tokens from Supabase.
export async function DELETE() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { getSupabaseAdmin } = await import("@/lib/supabase");
  const supabase = getSupabaseAdmin();
  await supabase.from("ms_credentials").delete().eq("id", "default");

  return NextResponse.json({ disconnected: true });
}
