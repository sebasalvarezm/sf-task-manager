import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { DEAL_DOCS_BUCKET } from "@/lib/deal-docs";

export const dynamic = "force-dynamic";

// Mints a fresh 60-second signed download URL for an account's current doc and
// redirects to it. The browser opens PDFs inline; Office files download.
// Always minted fresh on click — signed URLs are never stored or cached.
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accountId = req.nextUrl.searchParams.get("accountId")?.trim() ?? "";
  if (!accountId) {
    return NextResponse.json({ error: "Missing accountId" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data: row, error } = await supabase
      .from("deal_docs")
      .select("storage_path")
      .eq("sf_account_id", accountId)
      .maybeSingle();

    if (error || !row) {
      return NextResponse.json(
        { error: "No document for this account" },
        { status: 404 },
      );
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(DEAL_DOCS_BUCKET)
      .createSignedUrl(row.storage_path, 60);

    if (signError || !signed) {
      return NextResponse.json(
        { error: signError?.message ?? "Failed to sign URL" },
        { status: 500 },
      );
    }

    return NextResponse.redirect(signed.signedUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
