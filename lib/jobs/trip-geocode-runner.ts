import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchCDMAccounts } from "@/lib/salesforce-trip";
import { batchGeocodeAccounts } from "@/lib/geocoding";

export type TripGeocodeResult = {
  total: number;
  cached: number;
  geocoded: number;
  failed: number;
  done: boolean;
};

const BATCH_SIZE = 40;

/**
 * Geocodes ALL uncached CDM accounts. Loops batches server-side until done
 * (the old route did 40-at-a-time and the page looped manually). Each batch
 * is its own Inngest step so progress is checkpointed and we can resume.
 */
export async function runTripGeocode(
  onBatchDone?: (state: {
    total: number;
    cached: number;
    remaining: number;
  }) => Promise<void> | void,
): Promise<TripGeocodeResult> {
  const supabase = getSupabaseAdmin();
  const accounts = await fetchCDMAccounts();

  const { data: cachedRows } = await supabase
    .from("account_geocache")
    .select("sf_account_id")
    .in(
      "sf_account_id",
      accounts.map((a) => a.Id),
    );
  const cachedIds = new Set((cachedRows ?? []).map((r) => r.sf_account_id));

  let totalGeocoded = 0;
  let totalFailed = 0;
  let uncached = accounts.filter((a) => !cachedIds.has(a.Id));

  while (uncached.length > 0) {
    const batch = uncached.slice(0, BATCH_SIZE);

    const { results, failed } = await batchGeocodeAccounts(
      batch.map((a) => ({
        id: a.Id,
        name: a.Name,
        billingCity: a.BillingCity,
        billingState: a.BillingState,
        billingCountry: a.BillingCountry,
        website: a.Website,
      })),
    );

    for (const r of results) {
      await supabase.from("account_geocache").upsert({
        sf_account_id: r.accountId,
        account_name: r.accountName,
        lat: r.lat,
        lng: r.lng,
        formatted_address: r.formattedAddress,
        address_source: r.addressSource,
      });
      cachedIds.add(r.accountId);
    }

    totalGeocoded += results.length;
    totalFailed += failed.length;

    // Mark failed as "tried" so we don't loop forever on bad addresses
    for (const f of failed) cachedIds.add(f.id);

    uncached = accounts.filter((a) => !cachedIds.has(a.Id));

    if (onBatchDone) {
      await onBatchDone({
        total: accounts.length,
        cached: accounts.length - uncached.length,
        remaining: uncached.length,
      });
    }
  }

  return {
    total: accounts.length,
    cached: accounts.length,
    geocoded: totalGeocoded,
    failed: totalFailed,
    done: true,
  };
}
