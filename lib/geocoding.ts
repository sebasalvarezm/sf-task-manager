// Google Maps API utilities for the Trip Planner.
// Requires GOOGLE_MAPS_API_KEY env var with Geocoding, Places, and
// Distance Matrix APIs enabled. Turning a place into coordinates now lives in
// lib/geocoder.ts (Google first, OpenStreetMap as the fallback, cached).

import { geocodeLocation, type GeoPoint } from "./geocoder";

export type { GeoPoint } from "./geocoder";

function getApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_MAPS_API_KEY environment variable");
  return key;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type DistanceResult = {
  id: string;
  distanceMeters: number;
  distanceMiles: number;
  durationSeconds: number;
  durationMinutes: number;
  durationText: string;
};

export type GeocodeFailure = {
  id: string;
  name: string;
  reason: string;
  /** "unavailable" = no service could answer; "not_found" = nothing matched. */
  kind: "not_found" | "unavailable";
  /** The address geocoder itself couldn't answer (not just Google Places). */
  serviceDown?: boolean;
};

export type GeocodeAccountResult = {
  accountId: string;
  accountName: string;
  lat: number;
  lng: number;
  formattedAddress: string;
  addressSource: "billing" | "places";
};

const COUNTRY_TERMS_BY_CCTLD: Record<string, string[]> = {
  no: ["norway", "norge"],
  nl: ["netherlands", "nederland"],
  uk: ["united kingdom", "england", "scotland", "wales", "northern ireland"],
  ie: ["ireland"],
  dk: ["denmark", "danmark"],
  se: ["sweden", "sverige"],
  fi: ["finland", "suomi"],
  de: ["germany", "deutschland"],
  fr: ["france"],
  be: ["belgium", "belgique", "belgie", "belgië"],
  ch: ["switzerland", "schweiz", "suisse", "svizzera"],
  at: ["austria", "österreich"],
  ca: ["canada"],
  au: ["australia"],
  nz: ["new zealand"],
};

/** Reject a location that contradicts a reliable country-code domain. */
export function locationMatchesWebsiteCountry(
  location: string,
  website?: string | null,
): boolean {
  if (!website) return true;
  try {
    const parsed = new URL(website.startsWith("http") ? website : `https://${website}`);
    const tld = parsed.hostname.toLowerCase().split(".").pop() ?? "";
    const expectedTerms = COUNTRY_TERMS_BY_CCTLD[tld];
    if (!expectedTerms) return true;
    const normalizedLocation = location.toLowerCase();
    return expectedTerms.some((term) => normalizedLocation.includes(term));
  } catch {
    return true;
  }
}

// ── Geocode an address string ────────────────────────────────────────────────

/** Coordinates for a place, or null if not found / no service answered. See geocodeLocation for the reason. */
export async function geocodeAddress(address: string): Promise<GeoPoint | null> {
  const outcome = await geocodeLocation(address);
  return outcome.ok ? outcome.point : null;
}

// ── Find a business by name via Places Text Search ───────────────────────────

export type PlacesAnswer =
  | { status: "ok"; point: GeoPoint }
  | { status: "not_found" }
  | { status: "unavailable"; detail: string };

/** Google Places text search for a company, with the reason when it fails. */
export async function findBusinessLocationDetailed(
  companyName: string,
  website?: string | null
): Promise<PlacesAnswer> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return { status: "unavailable", detail: "Google Places: GOOGLE_MAPS_API_KEY isn't set" };

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

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    return { status: "unavailable", detail: "Google Places: no response (network or timeout)" };
  }
  if (!res.ok) return { status: "unavailable", detail: `Google Places: HTTP ${res.status}` };

  const data = (await res.json().catch(() => null)) as {
    status?: string;
    error_message?: string;
    results?: Array<{
      geometry: { location: { lat: number; lng: number } };
      formatted_address: string;
      name: string;
    }>;
  } | null;

  if (!data?.status) return { status: "unavailable", detail: "Google Places: unreadable reply" };
  if (data.status === "ZERO_RESULTS") return { status: "not_found" };
  if (data.status !== "OK") {
    return {
      status: "unavailable",
      detail: `Google Places said ${data.status}${data.error_message ? `: ${data.error_message}` : ""}`,
    };
  }

  const r = (data.results ?? []).find((candidate) =>
    locationMatchesWebsiteCountry(candidate.formatted_address, website),
  );
  if (!r) return { status: "not_found" };
  return {
    status: "ok",
    point: {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formattedAddress: r.formatted_address,
    },
  };
}

export async function findBusinessLocation(
  companyName: string,
  website?: string | null
): Promise<GeoPoint | null> {
  const answer = await findBusinessLocationDetailed(companyName, website);
  return answer.status === "ok" ? answer.point : null;
}

export async function findBusinessDinnerRestaurants(
  location: string,
): Promise<Array<{ name: string; description: string }>> {
  const key = getApiKey();
  const query = `best upscale business dinner restaurants near ${location}`;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&type=restaurant&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    status: string;
    results?: Array<{ name: string; rating?: number; user_ratings_total?: number; formatted_address?: string; price_level?: number }>;
  };
  if (data.status !== "OK") return [];
  return (data.results ?? [])
    .filter((r) => (r.rating ?? 0) >= 4 && (r.user_ratings_total ?? 0) >= 20)
    .sort((a, b) => ((b.rating ?? 0) * Math.log10((b.user_ratings_total ?? 0) + 10)) - ((a.rating ?? 0) * Math.log10((a.user_ratings_total ?? 0) + 10)))
    .slice(0, 3)
    .map((r) => ({
      name: r.name,
      description: `${r.rating?.toFixed(1) ?? "Well"}-rated restaurant${r.formatted_address ? ` near ${r.formatted_address}` : ""}, suitable for a sit-down business dinner.`,
    }));
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
  return (await getDrivingDistancesWithStatus(origin, destinations)).results;
}

/** Same, plus a plain reason when Google couldn't give drive times. */
export async function getDrivingDistancesWithStatus(
  origin: { lat: number; lng: number },
  destinations: { id: string; lat: number; lng: number }[]
): Promise<{ results: DistanceResult[]; error: string | null }> {
  if (destinations.length === 0) return { results: [], error: null };
  if (!process.env.GOOGLE_MAPS_API_KEY?.trim()) {
    return { results: [], error: "Drive times need Google Maps (GOOGLE_MAPS_API_KEY isn't set), so straight-line miles are shown." };
  }
  let chunkError: string | null = null;

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

      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) {
        chunkError = `Google Distance Matrix ${res ? `returned HTTP ${res.status}` : "didn't answer"}`;
        return chunk.map((d) => ({ ...d, failed: true }));
      }

      const data = (await res.json()) as {
        status: string;
        error_message?: string;
        rows?: Array<{
          elements: Array<{
            status: string;
            distance?: { value: number; text: string };
            duration?: { value: number; text: string };
          }>;
        }>;
      };

      if (data.status !== "OK" || !data.rows?.length) {
        chunkError = `Google Distance Matrix said ${data.status}${data.error_message ? `: ${data.error_message}` : ""}`;
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

  return {
    results,
    error: chunkError ? `Drive times unavailable (${chunkError}), so straight-line miles are shown.` : null,
  };
}

// ── Batch geocode accounts ───────────────────────────────────────────────────
// Geocodes a list of SF accounts. Uses the billing city/state/country when
// there is one (cached, Google then OpenStreetMap), otherwise Google Places
// by company name.

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
  failed: GeocodeFailure[];
}> {
  const results: GeocodeAccountResult[] = [];
  const failed: GeocodeFailure[] = [];

  for (const acct of accounts) {
    try {
      let geo: GeoPoint | null = null;
      let source: "billing" | "places" = "billing";
      const problems: string[] = [];
      let unavailable = false;
      let serviceDown = false;

      // Priority 1: the billing address, when Salesforce has a city
      if (acct.billingCity) {
        const parts = [acct.billingCity, acct.billingState, acct.billingCountry]
          .filter(Boolean)
          .join(", ");
        const outcome = await geocodeLocation(parts);
        if (outcome.ok) {
          geo = outcome.point;
        } else {
          problems.push(outcome.reason === "unavailable" ? outcome.message : `billing city "${parts}" not found`);
          unavailable = outcome.reason === "unavailable";
          serviceDown = unavailable;
        }
      } else {
        problems.push("no billing city in Salesforce");
      }

      // Priority 2: Google Places by company name
      if (!geo) {
        const answer = await findBusinessLocationDetailed(acct.name, acct.website);
        if (answer.status === "ok") {
          geo = answer.point;
          source = "places";
          unavailable = false;
        } else if (answer.status === "unavailable") {
          problems.push(answer.detail);
          // Only "unavailable" overall if the billing lookup didn't get a real answer either.
          unavailable = unavailable || !acct.billingCity;
        } else {
          problems.push("Google Places found no match by name");
          unavailable = false;
        }
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
          reason: problems.join("; "),
          kind: unavailable ? "unavailable" : "not_found",
          serviceDown,
        });
      }
    } catch (e: unknown) {
      failed.push({
        id: acct.id,
        name: acct.name,
        reason: e instanceof Error ? e.message : "Geocoding error",
        kind: "unavailable",
      });
    }
  }

  return { results, failed };
}
