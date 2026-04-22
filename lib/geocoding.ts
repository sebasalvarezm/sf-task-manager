// Google Maps API utilities for the Trip Planner.
// Requires GOOGLE_MAPS_API_KEY env var with Geocoding, Places, and
// Distance Matrix APIs enabled.

function getApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_MAPS_API_KEY environment variable");
  return key;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type GeoPoint = {
  lat: number;
  lng: number;
  formattedAddress: string;
};

export type DistanceResult = {
  id: string;
  distanceMeters: number;
  distanceMiles: number;
  durationSeconds: number;
  durationMinutes: number;
  durationText: string;
};

export type GeocodeAccountResult = {
  accountId: string;
  accountName: string;
  lat: number;
  lng: number;
  formattedAddress: string;
  addressSource: "billing" | "places";
};

// ── Geocode an address string ────────────────────────────────────────────────

export async function geocodeAddress(address: string): Promise<GeoPoint | null> {
  const key = getApiKey();
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    address
  )}&key=${key}`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    status: string;
    results?: Array<{
      geometry: { location: { lat: number; lng: number } };
      formatted_address: string;
    }>;
  };

  if (data.status !== "OK" || !data.results?.length) return null;

  const r = data.results[0];
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    formattedAddress: r.formatted_address,
  };
}

// ── Find a business by name via Places Text Search ───────────────────────────

export async function findBusinessLocation(
  companyName: string,
  website?: string | null
): Promise<GeoPoint | null> {
  const key = getApiKey();

  // Build a search query: company name, optionally with domain for precision
  let query = companyName;
  if (website) {
    const domain = website
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
    query = `${companyName} ${domain}`;
  }

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
    query
  )}&type=establishment&key=${key}`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    status: string;
    results?: Array<{
      geometry: { location: { lat: number; lng: number } };
      formatted_address: string;
      name: string;
    }>;
  };

  if (data.status !== "OK" || !data.results?.length) return null;

  const r = data.results[0];
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    formattedAddress: r.formatted_address,
  };
}

// ── Haversine distance (pure math, no API) ───────────────────────────────────

export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Driving distances via Distance Matrix API ────────────────────────────────
// Chunks at 25 destinations per request (API limit). Parallel requests.

export async function getDrivingDistances(
  origin: { lat: number; lng: number },
  destinations: { id: string; lat: number; lng: number }[]
): Promise<DistanceResult[]> {
  if (destinations.length === 0) return [];

  const key = getApiKey();
  const CHUNK_SIZE = 25;
  const results: DistanceResult[] = [];

  const chunks: { id: string; lat: number; lng: number }[][] = [];
  for (let i = 0; i < destinations.length; i += CHUNK_SIZE) {
    chunks.push(destinations.slice(i, i + CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const destParam = chunk
        .map((d) => `${d.lat},${d.lng}`)
        .join("|");
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${destParam}&mode=driving&units=imperial&key=${key}`;

      const res = await fetch(url);
      if (!res.ok) return chunk.map((d) => ({ ...d, failed: true }));

      const data = (await res.json()) as {
        status: string;
        rows?: Array<{
          elements: Array<{
            status: string;
            distance?: { value: number; text: string };
            duration?: { value: number; text: string };
          }>;
        }>;
      };

      if (data.status !== "OK" || !data.rows?.length) {
        return chunk.map((d) => ({ ...d, failed: true }));
      }

      const elements = data.rows[0].elements;
      return chunk.map((d, i) => {
        const el = elements[i];
        if (!el || el.status !== "OK" || !el.distance || !el.duration) {
          return { ...d, failed: true };
        }
        return {
          id: d.id,
          distanceMeters: el.distance.value,
          distanceMiles: Math.round(el.distance.value / 1609.34),
          durationSeconds: el.duration.value,
          durationMinutes: Math.round(el.duration.value / 60),
          durationText: el.duration.text,
          failed: false,
        };
      });
    })
  );

  for (const chunk of chunkResults) {
    for (const item of chunk) {
      if ("failed" in item && item.failed) continue;
      results.push(item as DistanceResult);
    }
  }

  return results;
}

// ── Batch geocode accounts ───────────────────────────────────────────────────
// Geocodes a list of SF accounts. Uses BillingCity if available, otherwise
// falls back to Google Places Text Search by company name.

export async function batchGeocodeAccounts(
  accounts: {
    id: string;
    name: string;
    billingCity?: string | null;
    billingState?: string | null;
    billingCountry?: string | null;
    website?: string | null;
  }[]
): Promise<{
  results: GeocodeAccountResult[];
  failed: { id: string; name: string; reason: string }[];
}> {
  const results: GeocodeAccountResult[] = [];
  const failed: { id: string; name: string; reason: string }[] = [];

  for (const acct of accounts) {
    // Rate limit: 100ms between calls
    await new Promise((r) => setTimeout(r, 100));

    try {
      let geo: GeoPoint | null = null;
      let source: "billing" | "places" = "billing";

      // Priority 1: geocode from billing address if city is available
      if (acct.billingCity) {
        const parts = [acct.billingCity, acct.billingState, acct.billingCountry]
          .filter(Boolean)
          .join(", ");
        geo = await geocodeAddress(parts);
        source = "billing";
      }

      // Priority 2: Google Places by company name
      if (!geo) {
        geo = await findBusinessLocation(acct.name, acct.website);
        source = "places";
      }

      if (geo) {
        results.push({
          accountId: acct.id,
          accountName: acct.name,
          lat: geo.lat,
          lng: geo.lng,
          formattedAddress: geo.formattedAddress,
          addressSource: source,
        });
      } else {
        failed.push({
          id: acct.id,
          name: acct.name,
          reason: "No geocode result from billing address or Google Places",
        });
      }
    } catch (e: unknown) {
      failed.push({
        id: acct.id,
        name: acct.name,
        reason: e instanceof Error ? e.message : "Geocoding error",
      });
    }
  }

  return { results, failed };
}
