import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchCDMAccounts } from "@/lib/salesforce-trip";
import {
  geocodeAddress,
  haversineDistance,
  getDrivingDistances,
} from "@/lib/geocoding";
import { discoverCompanies } from "@/lib/trip-discovery";

export type TripSearchInput = {
  location: string;
  radiusMiles?: number;
};

export type TripSearchResult = {
  userLocation: { lat: number; lng: number; formatted_address?: string } | null;
  radiusMiles: number;
  location: string;
  results: Array<{
    accountId: string;
    accountName: string;
    ownerName: string | null;
    address: string;
    addressSource: string;
    distanceMiles: number;
    durationMinutes: number | null;
    durationText: string | null;
    website: string | null;
    sfUrl: string | null;
    lastActivityDate: string | null;
    lat: number;
    lng: number;
  }>;
  geocodeStats: { total: number; cached: number; uncached: number };
  discovered: Awaited<ReturnType<typeof discoverCompanies>>["companies"] | null;
  discoveryStats: Awaited<ReturnType<typeof discoverCompanies>>["stats"] | null;
  discoveryError: string | null;
};

export async function runTripSearch(
  input: TripSearchInput,
): Promise<TripSearchResult> {
  const radiusMiles = input.radiusMiles ?? 150;

  // 1. Geocode user's location
  const userGeo = await geocodeAddress(input.location);
  if (!userGeo) {
    throw new Error(
      `Could not geocode "${input.location}". Try a more specific address.`,
    );
  }

  // 2. Fetch all CDM accounts (used by both search and discover)
  const accounts = await fetchCDMAccounts();

  // 3. Run search + discover in parallel
  const searchPromise = (async () => {
    const supabase = getSupabaseAdmin();
    const accountIds = accounts.map((a) => a.Id);
    const { data: cached } = await supabase
      .from("account_geocache")
      .select("*")
      .in("sf_account_id", accountIds);

    const cacheMap = new Map<
      string,
      {
        lat: number;
        lng: number;
        formatted_address: string;
        address_source: string;
      }
    >();
    for (const row of cached ?? []) cacheMap.set(row.sf_account_id, row);

    const uncachedCount = accounts.filter((a) => !cacheMap.has(a.Id)).length;

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
        geo.lng,
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

    const distResults = await getDrivingDistances(
      { lat: userGeo.lat, lng: userGeo.lng },
      nearby.map((n) => ({ id: n.account.Id, lat: n.lat, lng: n.lng })),
    );

    const distMap = new Map(distResults.map((d) => [d.id, d]));

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
      .sort(
        (a, b) =>
          (a.durationMinutes ?? 9999) - (b.durationMinutes ?? 9999),
      );

    return {
      results,
      geocodeStats: {
        total: accounts.length,
        cached: accounts.length - uncachedCount,
        uncached: uncachedCount,
      },
    };
  })();

  const discoverPromise = (async () => {
    try {
      const out = await discoverCompanies(
        input.location,
        { lat: userGeo.lat, lng: userGeo.lng },
        radiusMiles,
        accounts,
      );
      return { ok: true as const, ...out };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Discovery error";
      return { ok: false as const, message };
    }
  })();

  const [searchOut, discoverOut] = await Promise.all([
    searchPromise,
    discoverPromise,
  ]);

  return {
    userLocation: userGeo,
    radiusMiles,
    location: input.location,
    results: searchOut.results,
    geocodeStats: searchOut.geocodeStats,
    discovered: discoverOut.ok ? discoverOut.companies : null,
    discoveryStats: discoverOut.ok ? discoverOut.stats : null,
    discoveryError: discoverOut.ok ? null : discoverOut.message,
  };
}
