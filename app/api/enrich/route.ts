import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { enrichCompany } from "@/lib/enrichment";

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let url: string;
  try {
    const body = await request.json();
    url = body.url;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (!url || typeof url !== "string" || url.trim().length < 4) {
    return NextResponse.json(
      { error: "Please provide a valid website URL" },
      { status: 400 }
    );
  }

  try {
    const data = await enrichCompany(url.trim());
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Enrichment failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
