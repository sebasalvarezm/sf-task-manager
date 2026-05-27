import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { DEAL_DOCS_BUCKET, extForMime } from "@/lib/deal-docs";

export const dynamic = "force-dynamic";

// Mints a short-lived signed upload URL so the browser can PUT the file
// directly to Supabase Storage — bypassing Vercel's ~4.5MB request body limit.
// upsert:true allows the same path to be overwritten (replace-only model).
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const accountId =
    typeof body?.accountId === "string" ? body.accountId.trim() : "";
  const mimeType =
    typeof body?.mimeType === "string" ? body.mimeType.trim() : "";

  if (!accountId || !mimeType) {
    return NextResponse.json(
      { error: "Missing accountId or mimeType" },
      { status: 400 },
    );
  }

  // Salesforce IDs are alphanumeric; reject anything else to avoid building a
  // storage path with traversal characters.
  if (!/^[A-Za-z0-9]+$/.test(accountId)) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }

  const ext = extForMime(mimeType);
  if (!ext) {
    return NextResponse.json(
      {
        error: "Unsupported file type. Allowed: PDF, Word, PowerPoint, Excel.",
      },
      { status: 400 },
    );
  }

  const path = `${accountId}/current.${ext}`;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage
      .from(DEAL_DOCS_BUCKET)
      .createSignedUploadUrl(path, { upsert: true });

    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "Failed to create upload URL" },
        { status: 500 },
      );
    }

    return NextResponse.json({ signedUrl: data.signedUrl, path });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
