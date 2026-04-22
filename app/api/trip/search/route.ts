import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchCDMAccounts } from "@/lib/salesforce-trip";
import {
  geocodeAddress,
  haversineDistance,
  getDrivingDistances,
  batchGeocodeAccounts,
  GeocodeAccountResult,
} from "@/lib/geocoding";

export const maxDuration = 55;

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

  const radiusMiles = body.radiusMiles ?? 150;

  try {
    // 1. Geocode user's location
    const userGeo = await geocodeAddress(body.location);
    if (!userGeo) {
      return NextResponse.json(
        { error: `Could not geocode "${body.location}". Try a more specific address.` },
        { status: 400 }
      );
    }

    // 2. Fetch all CDM accounts from SF
    const accounts = await fetchCDMAccounts();

    // 3. Check Supabase cache for existing geocoded coordinates
    const supabase = getSupabaseAdmin();
    const accountIds = accounts.map((a) => a.Id);
    const { data: cached } = await supabase
      .from("account_geocache")
      .select("*")
      .in("sf_account_id", accountIds);

    const cacheMap = new Map<
      string,
      { lat: number; lng: number; formatted_address: string; address_source: string }
    >();
    for (const row of cached ?? []) {
      cacheMap.set(row.sf_account_id, row);
    }

    // 4. Geocode uncached accounts
    const uncached = accounts.filter((a) => !cacheMap.has(a.Id));
    let newlyGeocoded = 0;
    let failedCount = 0;

    if (uncached.length > 0) {
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
        cacheMap.set(r.accountId, {
          lat: r.lat,
          lng: r.lng,
          formatted_address: r.formattedAddress,
          address_source: r.addressSource,
        });
        await supabase.from("account_geocache").upsert({
          sf_account_id: r.accountId,
          account_name: r.accountName,
          lat: r.lat,
          lng: r.lng,
          formatted_address: r.formattedAddress,
          address_source: r.addressSource,
        });
      }
      newlyGeocoded = results.length;
      failedCount = failed.length;
    }

    // 5. Haversine pre-filter
    type NearbyAccount = {
      account: (typeof accounts)[number];
      lat: number;
      lng: number;
      address: string;
      addressSource: string;
      straightLineMiles: number;
    };

    const nearby: NearbyAccount[] = [];
    for (const acct of accounts) {
      const geo = cacheMap.get(acct.Id);
      if (!geo) continue;
      const dist = haversineDistance(
        userGeo.lat,
        userGeo.lng,
        geo.lat,
        geo.lng
      );
      if (dist <= radiusMiles) {
        nearby.push({
          account: acct,
          lat: geo.lat,
          lng: geo.lng,
          address: geo.formatted_address ?? "",
          addressSource: geo.address_source ?? "places",
          straightLineMiles: Math.round(dist),
        });
      }
    }

    // 6. Get real driving distances
    const distResults = await getDrivingDistances(
      { lat: userGeo.lat, lng: userGeo.lng },
      nearby.map((n) => ({ id: n.account.Id, lat: n.lat, lng: n.lng }))
    );

    const distMap = new Map(distResults.map((d) => [d.id, d]));

    // 7. Build and sort results
    const results = nearby
      .map((n) => {
        const dist = distMap.get(n.account.Id);
        return {
          accountId: n.account.Id,
          accountName: n.account.Name,
          ownerName: n.account.OwnerName,
          address: n.address,
          addressSource: n.addressSource,
          distanceMiles: dist?.distanceMiles ?? n.straightLineMiles,
          durationMinutes: dist?.durationMinutes ?? null,
          durationText: dist?.durationText ?? null,
          website: n.account.Website,
          sfUrl: n.account.SfUrl,
          lastActivityDate: n.account.LastActivityDate,
          lat: n.lat,
          lng: n.lng,
        };
      })
      .sort((a, b) => (a.durationMinutes ?? 9999) - (b.durationMinutes ?? 9999));

    return NextResponse.json({
      userLocation: userGeo,
      results,
      geocodeStats: {
        total: accounts.length,
        cached: accounts.length - uncached.length,
        newlyGeocoded,
        failed: failedCount,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
