import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  getQualityThresholds,
  saveQualityThresholds,
} from "@/lib/outreach-quality-settings";

export const dynamic = "force-dynamic";

// The admin-editable scoring rules behind the outreach quality ("BS")
// indicator. `isAdmin` rather than `isAuthenticated`: /stats is already
// admin-only via deny-by-default in middleware.ts, so this is defence in depth,
// matching the triage routes.

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  try {
    return NextResponse.json({ thresholds: await getQualityThresholds() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    // saveQualityThresholds validates field by field and echoes back what was
    // actually stored, so the client can show any value that fell back.
    const thresholds = await saveQualityThresholds(body);
    return NextResponse.json({ thresholds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    // Reading falls back to defaults when app_settings is missing, so the only
    // symptom is a failed save — worth naming the one-time setup step rather
    // than passing Postgres' schema-cache wording through to the user.
    if (/app_settings/.test(message)) {
      return NextResponse.json(
        {
          error:
            "The settings table has not been created yet. Run supabase/app-settings.sql once in the Supabase SQL Editor, then save again.",
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
