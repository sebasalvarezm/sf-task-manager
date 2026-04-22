import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { fetchCDMAccounts } from "@/lib/salesforce-trip";
import { discoverCompanies } from "@/lib/trip-discovery";

export const maxDuration = 300; // 5 minutes — discovery is thorough

// POST /api/trip/discover
// AI-powered discovery of NEW software companies near a location that fit
// CDM sub-verticals. Searches all 9 verticals in parallel, deduplicates
// against existing SF accounts, and checks ownership status.
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    location?: string;
    radiusMiles?: number;
  };

  if (!body.location) {
    return NextResponse.json({ error: "Missing location" }, { status: 400 });
  }

  try {
    // Fetch existing SF accounts for deduplication
    const sfAccounts = await fetchCDMAccounts();

    // Run discovery
    const { companies, stats } = await discoverCompanies(
      body.location,
      body.radiusMiles ?? 150,
      sfAccounts
    );

    return NextResponse.json({ companies, stats });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
