import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  DEAL_DOCS_BUCKET,
  PDF_MIME,
  extractMetricsFromPdf,
  metricsToColumns,
  rowToDealDoc,
  type DealDocRow,
} from "@/lib/deal-docs";

export const dynamic = "force-dynamic";

// Records the uploaded file's metadata (after the browser PUT to Storage),
// then — for PDFs only — downloads the bytes and extracts the 7 metrics via
// Claude. Extraction never blocks the upload: on any failure the row is still
// saved and the doc is openable; metrics fall back to manual entry.
export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const accountId =
    typeof body?.accountId === "string" ? body.accountId.trim() : "";
  const accountName =
    typeof body?.accountName === "string" ? body.accountName.trim() : null;
  const path = typeof body?.path === "string" ? body.path.trim() : "";
  const filename =
    typeof body?.filename === "string" ? body.filename.trim() : "";
  const mimeType =
    typeof body?.mimeType === "string" ? body.mimeType.trim() : "";
  const fileSize = typeof body?.fileSize === "number" ? body.fileSize : null;

  if (!accountId || !path || !filename || !mimeType) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  const isPdf = mimeType === PDF_MIME;
  const supabase = getSupabaseAdmin();

  try {
    // Note the prior file path so we can clean up an orphan if the new upload
    // used a different extension (e.g. replacing a .pdf with a .docx).
    const { data: prior } = await supabase
      .from("deal_docs")
      .select("storage_path")
      .eq("sf_account_id", accountId)
      .maybeSingle();

    // Upsert the row. Wipe the 7 metric columns on every (re)upload so stale
    // numbers from a previous doc never linger; PDFs are re-extracted below.
    const { data: saved, error: upsertError } = await supabase
      .from("deal_docs")
      .upsert(
        {
          sf_account_id: accountId,
          account_name: accountName,
          storage_path: path,
          filename,
          mime_type: mimeType,
          file_size: fileSize,
          hq: null,
          rev_usd: null,
          arr_usd: null,
          ebitda: null,
          num_customers: null,
          growth_rate: null,
          churn: null,
          extraction_status: isPdf ? "pending" : "skipped",
          uploaded_at: new Date().toISOString(),
        },
        { onConflict: "sf_account_id" },
      )
      .select()
      .single();

    if (upsertError || !saved) {
      return NextResponse.json(
        { error: upsertError?.message ?? "Failed to save document" },
        { status: 500 },
      );
    }

    // Best-effort: remove an orphaned previous file if the path changed.
    if (prior?.storage_path && prior.storage_path !== path) {
      try {
        await supabase.storage
          .from(DEAL_DOCS_BUCKET)
          .remove([prior.storage_path]);
      } catch {
        /* non-critical cleanup */
      }
    }

    // PDF only: download bytes and extract metrics synchronously.
    if (isPdf) {
      let status: "done" | "failed" = "failed";
      let metricsCols: Record<string, string | null> = {};
      try {
        const { data: blob, error: dlError } = await supabase.storage
          .from(DEAL_DOCS_BUCKET)
          .download(path);
        if (dlError || !blob) throw dlError ?? new Error("download failed");

        const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
        const metrics = await extractMetricsFromPdf(base64, filename);
        if (metrics) {
          metricsCols = metricsToColumns(metrics);
          status = "done";
        }
      } catch {
        status = "failed";
      }

      const { data: updated } = await supabase
        .from("deal_docs")
        .update({ ...metricsCols, extraction_status: status })
        .eq("sf_account_id", accountId)
        .select()
        .single();

      if (updated) {
        return NextResponse.json({ doc: rowToDealDoc(updated as DealDocRow) });
      }
    }

    return NextResponse.json({ doc: rowToDealDoc(saved as DealDocRow) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
