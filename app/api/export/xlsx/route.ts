import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { ExportError, buildWorkbook, parseExportRequest } from "@/lib/xlsx-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { filename, sheets } → a formatted .xlsx of exactly what the page sent
 * (the rows on screen). Formatting only: nothing is read from Salesforce or the
 * database, and nothing is written anywhere.
 */
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const req = parseExportRequest(await request.json().catch(() => null));
    const buffer = await buildWorkbook(req);
    const ascii = req.filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(req.filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ExportError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Export failed" }, { status: 500 });
  }
}
