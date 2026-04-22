import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchCDMAccounts } from "@/lib/salesforce-trip";
import { batchGeocodeAccounts } from "@/lib/geocoding";

export const maxDuration = 55;

// POST /api/trip/geocode-all
// Geocodes a BATCH of CDM accounts that aren't already cached.
// The frontend calls this in a loop until all accounts are done.
// Each call processes up to 40 uncached accounts (~10-15 seconds).
export async function POST() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const BATCH_SIZE = 40;

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
        cached: cachedIds.size,
        remaining: 0,
        batchGeocoded: 0,
        batchFailed: 0,
        done: true,
      });
    }

    // Process only the first BATCH_SIZE uncached accounts
    const batch = uncached.slice(0, BATCH_SIZE);

    const { results, failed } = await batchGeocodeAccounts(
      batch.map((a) => ({
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

    const remaining = uncached.length - batch.length;

    return NextResponse.json({
      total: accounts.length,
      cached: cachedIds.size + results.length,
      remaining,
      batchGeocoded: results.length,
      batchFailed: failed.length,
      done: remaining === 0,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
