import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchCDMAccounts } from "@/lib/salesforce-trip";
import { batchGeocodeAccounts, type GeocodeFailure } from "@/lib/geocoding";

export type TripGeocodeResult = {
  total: number;
  /** Accounts with coordinates after the scan (already had + newly placed). */
  cached: number;
  geocoded: number;
  failed: number;
  /** A few accounts that couldn't be placed, with the plain reason. */
  failedSamples: Array<{ name: string; reason: string }>;
  done: boolean;
};

export type UncachedAccount = {
  id: string;
  name: string;
  billingCity: string | null;
  billingState: string | null;
  billingCountry: string | null;
  website: string | null;
};

/**
 * Small batches so each one is its own Inngest step and stays well under the
 * 300-second limit, even when OpenStreetMap (one request a second) is doing
 * the work. Places already looked up come from the geocode cache.
 */
export const GEOCODE_BATCH_SIZE = 20;

/** Accounts not geocoded yet, plus how many are already done. */
export async function listUncachedAccounts(): Promise<{ total: number; alreadyCached: number; uncached: UncachedAccount[] }> {
  const supabase = getSupabaseAdmin();
  const accounts = await fetchCDMAccounts();
  const { data: cachedRows } = await supabase
    .from("account_geocache")
    .select("sf_account_id")
    .in("sf_account_id", accounts.map((a) => a.Id));
  const cachedIds = new Set((cachedRows ?? []).map((r) => r.sf_account_id));
  // Accounts with a billing city first: they work even if Google Places doesn't.
  const uncached = accounts
    .filter((a) => !cachedIds.has(a.Id))
    .sort((a, b) => Number(Boolean(b.BillingCity)) - Number(Boolean(a.BillingCity)))
    .map((a) => ({
      id: a.Id,
      name: a.Name,
      billingCity: a.BillingCity,
      billingState: a.BillingState,
      billingCountry: a.BillingCountry,
      website: a.Website,
    }));
  return { total: accounts.length, alreadyCached: accounts.length - uncached.length, uncached };
}

export class GeocodeServiceDownError extends Error {}

/**
 * Geocode one batch and store the hits. If no service could answer for any
 * account in the batch, stop the scan with the real reason instead of
 * marching through every account and calling them all "failed".
 */
export async function geocodeAccountBatch(
  batch: UncachedAccount[],
): Promise<{ geocoded: number; failed: GeocodeFailure[] }> {
  const supabase = getSupabaseAdmin();
  const { results, failed } = await batchGeocodeAccounts(batch);
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
  // Stop only when the address geocoder itself is down. Accounts that need
  // Google Places (no billing city) failing doesn't stop the others.
  if (batch.length > 0 && results.length === 0 && failed.some((f) => f.serviceDown)) {
    throw new GeocodeServiceDownError(
      `Geocoding service unavailable, so the scan stopped (accounts already placed are kept). Try again in a few minutes. Details: ${failed[0]?.reason ?? "no answer"}`,
    );
  }
  return { geocoded: results.length, failed };
}

/** Whole scan in one go (used by tests and anything not running in Inngest). */
export async function runTripGeocode(
  onBatchDone?: (state: { total: number; cached: number; remaining: number }) => Promise<void> | void,
): Promise<TripGeocodeResult> {
  const { total, alreadyCached, uncached } = await listUncachedAccounts();
  let geocoded = 0;
  const failed: GeocodeFailure[] = [];
  for (let i = 0; i < uncached.length; i += GEOCODE_BATCH_SIZE) {
    const out = await geocodeAccountBatch(uncached.slice(i, i + GEOCODE_BATCH_SIZE));
    geocoded += out.geocoded;
    failed.push(...out.failed);
    await onBatchDone?.({
      total,
      cached: alreadyCached + geocoded,
      remaining: Math.max(0, uncached.length - (i + GEOCODE_BATCH_SIZE)),
    });
  }
  return summarise(total, alreadyCached, geocoded, failed);
}

export function summarise(total: number, alreadyCached: number, geocoded: number, failed: GeocodeFailure[]): TripGeocodeResult {
  return {
    total,
    cached: alreadyCached + geocoded,
    geocoded,
    failed: failed.length,
    failedSamples: failed.slice(0, 5).map((f) => ({ name: f.name, reason: f.reason })),
    done: true,
  };
}
