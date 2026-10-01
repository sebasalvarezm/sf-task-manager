// Turn a place ("Toronto", "Des Moines, Iowa", "M5V 2X3", "50309", a street
// address) into coordinates, reliably for Canada and the US.
//
// Two services, tried in order:
//   1. Google Maps Geocoding (GOOGLE_MAPS_API_KEY), when the key works.
//   2. OpenStreetMap Nominatim (free) as the fallback. Its usage policy asks
//      for an identifying User-Agent with a contact email and at most one
//      request per second, so calls to it are queued 1.1 seconds apart.
//
// Results are cached (memory + the geocode_cache table), so repeat searches
// and "Scan Accounts" don't look the same place up twice.
//
// Failures say which kind they are:
//   - "not_found": a service answered and had no such place.
//   - "unavailable": no service could answer (key refused, rate-limited,
//     down). The message includes what each service said.
//
// Server-only.

import { getSupabaseAdmin } from "./supabase";

export type GeoPoint = { lat: number; lng: number; formattedAddress: string };

export type GeocodeProvider = "google" | "openstreetmap";

export type GeocodeOutcome =
  | { ok: true; point: GeoPoint; provider: GeocodeProvider | "cache" }
  | { ok: false; reason: "not_found" | "unavailable"; message: string; details: string[] };

type ProviderAnswer =
  | { status: "ok"; point: GeoPoint }
  | { status: "not_found" }
  | { status: "unavailable"; detail: string };

/** What kind of query this is. Postal/ZIP codes alone are pinned to their country. */
export type ParsedQuery =
  | { kind: "ca_postal"; text: string; postal: string }
  | { kind: "us_zip"; text: string; postal: string }
  | { kind: "text"; text: string };

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim().replace(/\s+/g, " ");
  const ca = text.match(/^([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)$/);
  if (ca) return { kind: "ca_postal", text, postal: `${ca[1]} ${ca[2]}`.toUpperCase() };
  const us = text.match(/^(\d{5})(?:-\d{4})?$/);
  if (us) return { kind: "us_zip", text, postal: us[1] };
  return { kind: "text", text };
}

/** Cache key: same place however it was typed ("  toronto " = "Toronto"). */
export function cacheKey(raw: string): string {
  const q = parseQuery(raw);
  if (q.kind !== "text") return `${q.kind}:${q.postal}`;
  return q.text.toLowerCase().replace(/[.,;]+$/g, "").replace(/\s*,\s*/g, ", ");
}

const TIMEOUT_MS = 8000;

// ── Google ──────────────────────────────────────────────────────────────────

const GOOGLE_STATUS_HELP: Record<string, string> = {
  REQUEST_DENIED: "the key was refused (Geocoding API not enabled for this key, key restrictions, or billing)",
  OVER_QUERY_LIMIT: "over the request quota",
  OVER_DAILY_LIMIT: "the daily limit or billing for the key",
  INVALID_REQUEST: "the request was invalid",
  UNKNOWN_ERROR: "a temporary Google error",
};

export async function googleGeocode(q: ParsedQuery): Promise<ProviderAnswer> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return { status: "unavailable", detail: "Google Maps: GOOGLE_MAPS_API_KEY isn't set" };
  const params = new URLSearchParams({ key });
  if (q.kind === "ca_postal") params.set("components", `postal_code:${q.postal}|country:CA`);
  else if (q.kind === "us_zip") params.set("components", `postal_code:${q.postal}|country:US`);
  else params.set("address", q.text);

  let res: Response;
  try {
    res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { status: "unavailable", detail: "Google Maps: no response (network or timeout)" };
  }
  if (!res.ok) return { status: "unavailable", detail: `Google Maps: HTTP ${res.status}` };
  const data = (await res.json().catch(() => null)) as {
    status?: string;
    error_message?: string;
    results?: Array<{ geometry: { location: { lat: number; lng: number } }; formatted_address: string }>;
  } | null;
  if (!data?.status) return { status: "unavailable", detail: "Google Maps: unreadable reply" };
  if (data.status === "OK" && data.results?.length) {
    const r = data.results[0];
    return {
      status: "ok",
      point: { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formattedAddress: r.formatted_address },
    };
  }
  if (data.status === "ZERO_RESULTS" || data.status === "OK") return { status: "not_found" };
  const help = GOOGLE_STATUS_HELP[data.status];
  return {
    status: "unavailable",
    detail: `Google Maps said ${data.status}${help ? ` (${help})` : ""}${data.error_message ? `: ${data.error_message}` : ""}`,
  };
}

// ── OpenStreetMap Nominatim ─────────────────────────────────────────────────

const NOMINATIM_GAP_MS = 1100;
let nominatimQueue: Promise<unknown> = Promise.resolve();
let nominatimLastCall = 0;

/** Test hook: lets tests run without real 1.1s waits. */
export const nominatimClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

function contactEmail(): string {
  return process.env.GEOCODER_CONTACT_EMAIL?.trim() || "sebastian@valstonecorp.com";
}

/** Runs `fn` after the previous Nominatim call, at least 1.1s after it started. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimQueue.then(async () => {
    const wait = nominatimLastCall + NOMINATIM_GAP_MS - nominatimClock.now();
    if (wait > 0) await nominatimClock.sleep(wait);
    nominatimLastCall = nominatimClock.now();
    return fn();
  });
  nominatimQueue = run.catch(() => undefined);
  return run;
}

/** "225 Front Street West, Toronto, Ontario, Canada" instead of OSM's long display name. */
export function shortOsmAddress(row: { display_name: string; address?: Record<string, string> }): string {
  const a = row.address;
  if (!a) return row.display_name;
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const place = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.county;
  const parts = [street || null, place, a.state, a.postcode && (street || !place) ? a.postcode : null, a.country].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length >= 2 ? parts.join(", ") : row.display_name;
}

export async function nominatimGeocode(q: ParsedQuery): Promise<ProviderAnswer> {
  const params = new URLSearchParams({ format: "jsonv2", limit: "1", addressdetails: "1", email: contactEmail() });
  if (q.kind === "ca_postal") {
    params.set("postalcode", q.postal);
    params.set("countrycodes", "ca");
  } else if (q.kind === "us_zip") {
    params.set("postalcode", q.postal);
    params.set("countrycodes", "us");
  } else {
    params.set("q", q.text);
  }
  return throttled(async () => {
    let res: Response;
    try {
      res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: {
          "User-Agent": `Valstone-Trip-Planner/1.0 (${contactEmail()})`,
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      return { status: "unavailable", detail: "OpenStreetMap: no response (network or timeout)" } as const;
    }
    if (res.status === 429) return { status: "unavailable", detail: "OpenStreetMap: rate-limited (HTTP 429)" } as const;
    if (!res.ok) return { status: "unavailable", detail: `OpenStreetMap: HTTP ${res.status}` } as const;
    const rows = (await res.json().catch(() => null)) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      address?: Record<string, string>;
    }> | null;
    if (!Array.isArray(rows)) return { status: "unavailable", detail: "OpenStreetMap: unreadable reply" } as const;
    if (rows.length === 0) return { status: "not_found" } as const;
    const lat = Number(rows[0].lat);
    const lng = Number(rows[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { status: "not_found" } as const;
    return { status: "ok", point: { lat, lng, formattedAddress: shortOsmAddress(rows[0]) } } as const;
  });
}

// ── Cache ───────────────────────────────────────────────────────────────────

const memory = new Map<string, GeoPoint>();
const MEMORY_MAX = 2000;

async function readCache(key: string): Promise<GeoPoint | null> {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const { data } = await getSupabaseAdmin()
      .from("geocode_cache")
      .select("lat, lng, formatted_address")
      .eq("query_key", key)
      .maybeSingle();
    if (!data) return null;
    const point = { lat: data.lat as number, lng: data.lng as number, formattedAddress: (data.formatted_address as string) ?? "" };
    memory.set(key, point);
    return point;
  } catch {
    return null; // table missing or DB blip: just look it up again
  }
}

async function writeCache(key: string, point: GeoPoint, provider: GeocodeProvider): Promise<void> {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
  memory.set(key, point);
  try {
    await getSupabaseAdmin().from("geocode_cache").upsert(
      {
        query_key: key,
        lat: point.lat,
        lng: point.lng,
        formatted_address: point.formattedAddress,
        provider,
        created_at: new Date().toISOString(),
      },
      { onConflict: "query_key" },
    );
  } catch {
    /* caching is best-effort */
  }
}

export function clearGeocodeMemoryCache() {
  memory.clear();
}

// ── Public ──────────────────────────────────────────────────────────────────

export type ProviderFn = (q: ParsedQuery) => Promise<ProviderAnswer>;
const DEFAULT_PROVIDERS: Array<[GeocodeProvider, ProviderFn]> = [
  ["google", googleGeocode],
  ["openstreetmap", nominatimGeocode],
];

export async function geocodeLocation(
  raw: string,
  providers: Array<[GeocodeProvider, ProviderFn]> = DEFAULT_PROVIDERS,
): Promise<GeocodeOutcome> {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "not_found", message: "Enter a place to search from.", details: [] };
  const key = cacheKey(text);
  const cached = await readCache(key);
  if (cached) return { ok: true, point: cached, provider: "cache" };

  const q = parseQuery(text);
  const details: string[] = [];
  let someoneAnswered = false;
  for (const [name, provider] of providers) {
    const answer = await provider(q);
    if (answer.status === "ok") {
      await writeCache(key, answer.point, name);
      return { ok: true, point: answer.point, provider: name };
    }
    if (answer.status === "not_found") {
      someoneAnswered = true;
      details.push(`${name === "google" ? "Google Maps" : "OpenStreetMap"}: no match`);
    } else {
      details.push(answer.detail);
    }
  }
  if (someoneAnswered) {
    return {
      ok: false,
      reason: "not_found",
      message: `Couldn't find "${text}". Check the spelling, or add the province or state (e.g. "London, ON").`,
      details,
    };
  }
  return {
    ok: false,
    reason: "unavailable",
    message: `The geocoding service is unavailable right now, so "${text}" couldn't be looked up. Try again in a minute. (${details.join("; ")})`,
    details,
  };
}
