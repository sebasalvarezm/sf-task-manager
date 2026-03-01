import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getValidCredentials } from "@/lib/token-manager";

// Returns whether Salesforce is currently connected.
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const credentials = await getValidCredentials();
  return NextResponse.json({ connected: credentials !== null });
}

// Disconnect: delete the stored tokens from Supabase.
export async function DELETE() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { getSupabaseAdmin } = await import("@/lib/supabase");
  const supabase = getSupabaseAdmin();
  await supabase.from("sf_credentials").delete().eq("id", "default");

  return NextResponse.json({ disconnected: true });
}
