import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchCDMAccounts } from "@/lib/salesforce-trip";
import { batchGeocodeAccounts } from "@/lib/geocoding";

export const maxDuration = 55;

// POST /api/trip/geocode-all
// Batch geocodes all CDM accounts that aren't already cached in Supabase.
// Triggered by the "Scan Accounts" button on the Trip Planner page.
export async function POST() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const accounts = await fetchCDMAccounts();

    // Check which are already cached
    const supabase = getSupabaseAdmin();
    const { data: cached } = await supabase
      .from("account_geocache")
      .select("sf_account_id")
      .in(
        "sf_account_id",
        accounts.map((a) => a.Id)
      );

    const cachedIds = new Set((cached ?? []).map((r) => r.sf_account_id));
    const uncached = accounts.filter((a) => !cachedIds.has(a.Id));

    if (uncached.length === 0) {
      return NextResponse.json({
        total: accounts.length,
        alreadyCached: cachedIds.size,
        newlyGeocoded: 0,
        failed: 0,
        failures: [],
      });
    }

    const { results, failed } = await batchGeocodeAccounts(
      uncached.map((a) => ({
        id: a.Id,
        name: a.Name,
        billingCity: a.BillingCity,
        billingState: a.BillingState,
        billingCountry: a.BillingCountry,
        website: a.Website,
      }))
    );

    // Upsert into cache
    for (const r of results) {
      await supabase.from("account_geocache").upsert({
        sf_account_id: r.accountId,
        account_name: r.accountName,
        lat: r.lat,
        lng: r.lng,
        formatted_address: r.formattedAddress,
        address_source: r.addressSource,
      });
    }

    return NextResponse.json({
      total: accounts.length,
      alreadyCached: cachedIds.size,
      newlyGeocoded: results.length,
      failed: failed.length,
      failures: failed.slice(0, 20),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
